/**
 * 巡演装车单状态管理（Zustand）
 *
 * 关键约束：
 * - 逐批写入 IndexedDB，每写成功一批就把 lastWrittenBatchId 前移；
 *   写入失败按指数退避重试，重试耗尽则计划置 failed，重开页面从最后一批之后继续；
 * - 已封车批次永不参与重排，未封车批次在源数据（场次/角色/影件/容量）变化后重新装车；
 * - 装车批次由确定性 id（batch:{playId}:{sceneId}）标识，同场次重建幂等。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  bulkPutLoadBatches,
  deletePendingLoadBatches,
  deletePlanData,
  getLoadPlan,
  listLoadBatchesByPlay,
  listRolesByScenes,
  listScenesByPlay,
  putLoadBatch,
  putLoadPlan,
  type LoadBatchRow,
  type LoadPlanRow,
  type PlayRow,
  type RoleRow,
  type SceneRow,
} from '../utils/db';
import { loadBatchId, loadPlanId, type LoadBatch, type LoadPlan } from '../types/loading';
import {
  buildSourceSignature,
  packBatches,
  repackPending,
  type PackedBatch,
  type PackedSceneInput,
} from '../utils/packing';
import { nowIso } from '../utils/uuid';

/** 写入失败的最大尝试次数（首写 + 2 次重试） */
const MAX_WRITE_ATTEMPTS = 3;
/** 重试基础退避毫秒数（200ms、400ms） */
const RETRY_BASE_DELAY_MS = 200;

/** 写入失败后按指数退避重试；仍失败则抛出，由上层把计划置为中断态 */
async function withRetry<T>(task: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_WRITE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : '本地存储写入失败';
  throw new Error(`${label}已重试 ${MAX_WRITE_ATTEMPTS} 次仍失败：${detail}`);
}

export interface LoadingPlanState {
  plan: LoadPlanRow | null;
  batches: LoadBatchRow[];
  /** 当前源数据签名（场次/角色/影件） */
  sourceSig: string;
  /** 源数据在装车后是否发生改动（未封车批次可重排） */
  sourceChanged: boolean;
  loading: boolean;
  /** 是否正在逐批写入（生成 / 续写 / 重排） */
  writing: boolean;
  progress: { done: number; total: number };
  error: string;

  loadPlanForPlay: (play: PlayRow) => Promise<void>;
  clear: () => void;
  /** 生成装车单（无单时）或源改动/改容量后的未封批次重排（有单时） */
  generateOrReseat: (play: PlayRow, capacity: number) => Promise<void>;
  /** 写入中断后续写：从最后一批之后继续 */
  continueWriting: (play: PlayRow) => Promise<void>;
  /** 封一辆车 */
  sealVehicle: (play: PlayRow, vehicleNo: number) => Promise<void>;
  /** 解封最后一辆已封车（随后未封批次重排） */
  unsealLastVehicle: (play: PlayRow) => Promise<void>;
  /** 删除整张装车单后按当前容量重新生成 */
  rebuild: (play: PlayRow, capacity: number) => Promise<void>;
  orderedBatches: () => LoadBatchRow[];
}

interface PlanSource {
  scenes: SceneRow[];
  roles: RoleRow[];
  sig: string;
}

async function fetchSource(playId: string): Promise<PlanSource> {
  const scenes = await listScenesByPlay(playId);
  const roles = await listRolesByScenes(scenes.map((scene) => scene.id));
  return { scenes, roles, sig: buildSourceSignature(scenes, roles) };
}

/** 装车算法结果 → 待落库批次行（确定性 id，幂等覆盖） */
function toPendingRow(packed: PackedBatch, stamp: string): LoadBatchRow {
  return {
    id: loadBatchId(packed.playId, packed.sceneId),
    playId: packed.playId,
    sceneId: packed.sceneId,
    seq: packed.seq,
    sceneTitle: packed.sceneTitle,
    roleNames: packed.roleNames,
    screenSpec: packed.screenSpec,
    items: packed.items,
    volume: packed.volume,
    status: 'pending',
    vehicleNo: packed.vehicleNo,
    orderInVehicle: packed.orderInVehicle,
    delayed: packed.delayed,
    overCapacity: packed.overCapacity,
    note: packed.note,
    sealedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
}

/** 以已封车为锚点，重新规划全部待封批次 */
function planPendingRows(
  source: PlanSource,
  sealed: LoadBatchRow[],
  capacity: number,
  stamp: string,
): { pendingRows: LoadBatchRow[]; delayedSceneIds: string[]; totalVehicles: number } {
  const repacked = repackPending(source.scenes, source.roles, sealed, capacity);
  return {
    pendingRows: repacked.batches.map((batch) => toPendingRow(batch, stamp)),
    delayedSceneIds: repacked.delayedSceneIds,
    totalVehicles: repacked.totalVehicles,
  };
}

/**
 * 逐批写入待封批次：已存在（已封车）的批次跳过；
 * 待封批次从 resumeAfterId 之后开始写，每批成功即前移 lastWrittenBatchId，
 * 保证重开页面时「从最后一批继续」。
 */
async function writeBatchesSequentially(
  plan: LoadPlanRow,
  pendingRows: LoadBatchRow[],
  sealedIds: Set<string>,
  resumeAfterId: string | null,
  onProgress: (done: number, total: number) => void,
): Promise<{ lastWrittenBatchId: string | null; totalVehicles: number }> {
  // 待封批次按车号、车中次序排列，与按车点货顺序一致
  const orderedPending = [...pendingRows].sort(
    (a, b) => a.vehicleNo - b.vehicleNo || a.orderInVehicle - b.orderInVehicle || a.seq - b.seq,
  );
  let startIndex = 0;
  if (resumeAfterId !== null) {
    const idx = orderedPending.findIndex((row) => row.id === resumeAfterId);
    startIndex = idx >= 0 ? idx + 1 : 0;
  }

  let lastWrittenBatchId = resumeAfterId;
  let done = 0;
  const total = orderedPending.length - startIndex;
  onProgress(0, total);

  for (let i = startIndex; i < orderedPending.length; i += 1) {
    const row = orderedPending[i];
    if (sealedIds.has(row.id)) continue; // 已封车行不覆盖
    await withRetry(() => putLoadBatch(row), `第 ${row.seq} 场批次写入`);
    lastWrittenBatchId = row.id;
    done += 1;
    onProgress(done, total);

    // 把断点随计划一起持久化
    const checkpoint: LoadPlanRow = {
      ...plan,
      lastWrittenBatchId,
      status: 'building',
      errorMessage: '',
      failedAt: null,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    };
    await withRetry(() => putLoadPlan(checkpoint), '装车进度记录');
    Object.assign(plan, checkpoint);
  }

  const totalVehicles = orderedPending.reduce((max, row) => Math.max(max, row.vehicleNo), 0);
  return { lastWrittenBatchId, totalVehicles };
}

/** 全部批次写入成功：计划置 ready，并刷新内存态 */
async function finalizePlan(
  plan: LoadPlanRow,
  pendingRows: LoadBatchRow[],
  sourceSig: string,
  lastWrittenBatchId: string | null,
  totalVehicles: number,
  set: (partial: Partial<LoadingPlanState>) => void,
): Promise<LoadPlanRow> {
  const sealedRows = (await listLoadBatchesByPlay(plan.playId)).filter((row) => row.status === 'sealed');
  const finalized: LoadPlanRow = {
    ...plan,
    status: 'ready',
    sourceSig,
    lastWrittenBatchId,
    totalVehicles,
    delayedSceneIds: pendingRows.filter((row) => row.delayed).map((row) => row.sceneId),
    errorMessage: '',
    failedAt: null,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await withRetry(() => putLoadPlan(finalized), '装车单完成记录');
  set({
    plan: finalized,
    batches: [...sealedRows, ...pendingRows],
    sourceSig,
    sourceChanged: false,
    writing: false,
    progress: { done: pendingRows.length, total: pendingRows.length },
    error: '',
  });
  return finalized;
}

/** 写入彻底失败：把中断信息落库（尽力一次），并同步内存态供界面续写 */
async function markFailed(
  plan: LoadPlanRow | null,
  error: unknown,
  set: (partial: Partial<LoadingPlanState>) => void,
): Promise<void> {
  if (!plan) return;
  const message = error instanceof Error ? error.message : '本地存储写入失败';
  const failed: LoadPlanRow = {
    ...plan,
    status: 'failed',
    errorMessage: message,
    failedAt: nowIso(),
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  try {
    await putLoadPlan(failed);
  } catch {
    /* 中断态落库失败时保持内存错误信息，不二次抛出 */
  }
  set({ plan: failed, writing: false, error: message });
}

export const useLoadingStore = create<LoadingPlanState>((set, get) => ({
  plan: null,
  batches: [],
  sourceSig: '',
  sourceChanged: false,
  loading: false,
  writing: false,
  progress: { done: 0, total: 0 },
  error: '',

  async loadPlanForPlay(play) {
    set({ loading: true, error: '' });
    try {
      const [plan, source] = await Promise.all([getLoadPlan(play.id), fetchSource(play.id)]);
      const batches = plan ? await listLoadBatchesByPlay(play.id) : [];
      set({
        plan: plan ?? null,
        batches,
        sourceSig: source.sig,
        sourceChanged: plan ? plan.sourceSig !== source.sig : false,
        loading: false,
        progress: { done: 0, total: 0 },
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '装车单读取失败' });
    }
  },

  clear() {
    set({ plan: null, batches: [], sourceSig: '', sourceChanged: false, error: '', progress: { done: 0, total: 0 } });
  },

  async generateOrReseat(play, capacity) {
    set({ writing: true, error: '', progress: { done: 0, total: 0 } });
    try {
      const source = await fetchSource(play.id);
      const existing = (await getLoadPlan(play.id)) ?? null;
      const stamp = nowIso();
      if (existing === null) {
        // 旧剧目 / 新剧目：一场一批，按场序装车
        await runFreshPack(play, source, capacity, stamp, set);
      } else {
        // 已有装车单：已封车保留，未封批次按当前容量与最新源重排
        await runReseat(play, existing, source, capacity, stamp, set);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '装车单生成失败';
      await markFailed(get().plan ?? null, error, set);
      // 计划尚未建档（如无场次）时也要解除写入态并回显错误
      if (!get().plan) set({ writing: false, error: message });
    }
  },

  async continueWriting(play) {
    const existing = get().plan;
    if (!existing || existing.status !== 'failed') return;
    set({ writing: true, error: '', progress: { done: 0, total: 0 } });
    try {
      const source = await fetchSource(play.id);
      const stamp = nowIso();
      if (existing.sourceSig !== source.sig) {
        // 中断期间源数据也变了：按「保留已封车 + 未封重排」重建待封批次，再从头逐批写入
        await runReseat(play, existing, source, existing.vehicleCapacity, stamp, set);
      } else {
        // 断点续写：按当前源重新规划（布局不变，确定性 id 幂等），从最后已写批次之后继续；
        // 已写批次在库里但未写批次只存在于规划中，因此必须重新规划，不能只读库。
        const sealed = (await listLoadBatchesByPlay(play.id)).filter((batch) => batch.status === 'sealed');
        const { pendingRows, totalVehicles } = planPendingRows(source, sealed, existing.vehicleCapacity, stamp);
        const plan: LoadPlanRow = { ...existing, status: 'building', errorMessage: '', failedAt: null, updatedAt: stamp };
        const sealedIds = new Set(sealed.map((batch) => batch.id));
        const { lastWrittenBatchId } = await writeBatchesSequentially(
          plan,
          pendingRows,
          sealedIds,
          existing.lastWrittenBatchId,
          (done, total) => set({ progress: { done, total } }),
        );
        const totalWithSealed = Math.max(totalVehicles, ...sealed.map((batch) => batch.vehicleNo), 0);
        await finalizePlan(plan, pendingRows, source.sig, lastWrittenBatchId, totalWithSealed, set);
      }
    } catch (error) {
      await markFailed(get().plan, error, set);
    }
  },

  async sealVehicle(play, vehicleNo) {
    const existing = get().plan;
    if (!existing) return;
    const targets = get().batches.filter((batch) => batch.vehicleNo === vehicleNo && batch.status === 'pending');
    if (targets.length === 0) return;
    const stamp = nowIso();
    const sealedRows: LoadBatchRow[] = targets.map((batch) => ({
      ...batch,
      status: 'sealed',
      sealedAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }));
    await withRetry(() => bulkPutLoadBatches(sealedRows), `第 ${vehicleNo} 车封车`);
    await get().loadPlanForPlay(play);
  },

  async unsealLastVehicle(play) {
    const existing = get().plan;
    if (!existing) return;
    const sealedVehicles = [
      ...new Set(get().batches.filter((batch) => batch.status === 'sealed').map((batch) => batch.vehicleNo)),
    ].sort((a, b) => b - a);
    if (sealedVehicles.length === 0) return;
    const lastVehicle = sealedVehicles[0];
    const stamp = nowIso();
    const reopened = get()
      .batches.filter((batch) => batch.vehicleNo === lastVehicle && batch.status === 'sealed')
      .map((batch) => ({
        ...batch,
        status: 'pending' as const,
        sealedAt: null,
        updatedAt: stamp,
        revision: ROW_REVISION,
      }));
    await withRetry(() => bulkPutLoadBatches(reopened), `第 ${lastVehicle} 车解封`);
    const refreshed = (await getLoadPlan(play.id)) ?? existing;
    const source = await fetchSource(play.id);
    set({ writing: true, error: '' });
    try {
      // 解封后整体重排未封批次（此时已无「最后已封车」之后的封车）
      await runReseat(play, refreshed, source, refreshed.vehicleCapacity, nowIso(), set);
    } catch (error) {
      await markFailed(get().plan, error, set);
    }
  },

  async rebuild(play, capacity) {
    await deletePlanData(play.id);
    set({ plan: null, batches: [], sourceChanged: false });
    await get().generateOrReseat(play, capacity);
  },

  orderedBatches() {
    return [...get().batches].sort(
      (a, b) => a.vehicleNo - b.vehicleNo || a.orderInVehicle - b.orderInVehicle || a.seq - b.seq,
    );
  },
}));

/** 无装车单：首次按场序装车并逐批写入（含失败重试与断点） */
async function runFreshPack(
  play: PlayRow,
  source: PlanSource,
  capacity: number,
  stamp: string,
  set: (partial: Partial<LoadingPlanState>) => void,
): Promise<void> {
  if (source.scenes.length === 0) {
    throw new Error('这出戏还没有场次，先到「场次拆分」建档后再来生成装车单');
  }
  const inputs: PackedSceneInput[] = source.scenes.map((scene) => ({
    scene,
    roles: source.roles.filter((role) => role.sceneId === scene.id),
  }));
  const packed = packBatches(inputs, capacity, 1);
  const pendingRows = packed.batches.map((batch) => toPendingRow(batch, stamp));

  // 先落计划行：即使首批写入就失败，中断态也有单可续（从最后一批继续）
  const plan: LoadPlanRow = {
    id: loadPlanId(play.id),
    playId: play.id,
    vehicleCapacity: capacity,
    status: 'building',
    lastWrittenBatchId: null,
    sourceSig: source.sig,
    batchOrder: pendingRows.map((row) => row.id),
    totalVehicles: packed.totalVehicles,
    delayedSceneIds: packed.delayedSceneIds,
    errorMessage: '',
    failedAt: null,
    builtAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await withRetry(() => putLoadPlan(plan), '装车单建档');
  set({ plan });

  const { lastWrittenBatchId, totalVehicles } = await writeBatchesSequentially(
    plan,
    pendingRows,
    new Set(),
    null,
    (done, total) => set({ progress: { done, total } }),
  );
  await finalizePlan(plan, pendingRows, source.sig, lastWrittenBatchId, totalVehicles, set);
}

/** 已有装车单：已封车批次保留，未封批次清理后按当前源数据与容量重排并逐批写入 */
async function runReseat(
  play: PlayRow,
  existing: LoadPlanRow,
  source: PlanSource,
  capacity: number,
  stamp: string,
  set: (partial: Partial<LoadingPlanState>) => void,
): Promise<void> {
  const sealed = (await listLoadBatchesByPlay(play.id)).filter((batch) => batch.status === 'sealed');

  // 清理待封批次孤儿行，再以已封车为锚点重排
  await withRetry(() => deletePendingLoadBatches(play.id), '清理旧批次');
  const { pendingRows, totalVehicles, delayedSceneIds } = planPendingRows(
    source,
    sealed,
    capacity,
    stamp,
  );

  const plan: LoadPlanRow = {
    ...existing,
    vehicleCapacity: capacity,
    status: 'building',
    lastWrittenBatchId: null,
    sourceSig: source.sig,
    batchOrder: [...sealed.map((batch) => batch.id), ...pendingRows.map((row) => row.id)],
    totalVehicles,
    delayedSceneIds,
    errorMessage: '',
    failedAt: null,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await withRetry(() => putLoadPlan(plan), '装车单重排建档');
  set({ plan });

  const sealedIds = new Set(sealed.map((batch) => batch.id));
  const { lastWrittenBatchId } = await writeBatchesSequentially(
    plan,
    pendingRows,
    sealedIds,
    null,
    (done, total) => set({ progress: { done, total } }),
  );
  const totalWithSealed = Math.max(totalVehicles, ...sealed.map((batch) => batch.vehicleNo), 0);
  await finalizePlan(plan, pendingRows, source.sig, lastWrittenBatchId, totalWithSealed, set);
}

/** 工具类型再导出，供页面引用 */
export type { LoadPlan, LoadBatch };
