/**
 * 巡演装车单状态管理（Zustand）
 *
 * 语义：
 * - 一剧一单，旧剧目首次进入时懒建档（不改动任何既有数据）；
 * - 已封车批次持久化为快照；场次 / 角色 / 影件 / 容量改动只影响未封车尾部（由 buildManifestView 现算）；
 * - 只能封第一辆未封车、只能解最后一辆已封车；
 * - 全部 IndexedDB 写入经 withRetry 重试；重开页面后从最后一批已封车继续；
 * - 封车后全部批次已封时，可「清空封车记录」重新开排。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  getLoadingManifestByPlay,
  listRolesByScenes,
  listScenesByPlay,
  putLoadingManifest,
  type LoadingManifestRow,
  type RoleRow,
  type SceneRow,
} from '../utils/db';
import {
  DEFAULT_TRUCK_CAPACITY,
  clampTruckCapacity,
  type LoadUnit,
} from '../types/loading';
import { buildLoadUnits, cloneUnits, packUnits } from '../utils/loading';
import { withRetry } from '../utils/retry';
import { nowIso, uuid } from '../utils/uuid';

interface LoadingStoreState {
  manifest: LoadingManifestRow | null;
  scenes: SceneRow[];
  roles: RoleRow[];
  activePlayId: string | null;
  loading: boolean;
  /** 写入（封车/解封/改容量）进行中 */
  mutating: boolean;
  error: string;
  /** 载入某剧目的装车单与最新场次/影件（重开后从最后一批已封车继续） */
  loadManifest: (playId: string) => Promise<void>;
  clearManifest: () => void;
  /** 确保装车单行已建档（旧剧目懒建档），返回当前行 */
  ensureManifest: (playId: string) => Promise<LoadingManifestRow>;
  /** 更新每车容量；仅重排未封车尾部 */
  setCapacity: (playId: string, capacity: number) => Promise<void>;
  /** 封第一辆未封车（按当前尾部配批结果快照落库） */
  sealNextBatch: (playId: string) => Promise<void>;
  /** 解开最后一辆已封车（仅允许逆序解封） */
  unsealLastBatch: (playId: string) => Promise<void>;
  /** 清空全部封车批次（回到未封车状态，容量保留） */
  resetSealedBatches: (playId: string) => Promise<void>;
}

/** 生成空白装车单行并落库 */
async function createManifest(playId: string, capacity: number): Promise<LoadingManifestRow> {
  const stamp = nowIso();
  const row: LoadingManifestRow = {
    id: uuid(),
    playId,
    truckCapacity: clampTruckCapacity(capacity),
    sealedBatches: [],
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await withRetry(() => putLoadingManifest(row));
  return row;
}

export const useLoadingStore = create<LoadingStoreState>((set, get) => ({
  manifest: null,
  scenes: [],
  roles: [],
  activePlayId: null,
  loading: false,
  mutating: false,
  error: '',

  async loadManifest(playId) {
    set({ loading: true, error: '' });
    try {
      const [manifest, scenes] = await Promise.all([
        getLoadingManifestByPlay(playId),
        listScenesByPlay(playId),
      ]);
      const roles = await listRolesByScenes(scenes.map((scene) => scene.id));
      set({ manifest: manifest ?? null, scenes, roles, activePlayId: playId, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '装车单读取失败' });
    }
  },

  clearManifest() {
    set({ manifest: null, scenes: [], roles: [], activePlayId: null });
  },

  async ensureManifest(playId) {
    const existing = get().activePlayId === playId ? get().manifest : await getLoadingManifestByPlay(playId);
    if (existing) return existing;
    const created = await createManifest(playId, DEFAULT_TRUCK_CAPACITY);
    set((state) =>
      state.activePlayId === playId
        ? { manifest: created }
        : { manifest: created, activePlayId: playId },
    );
    return created;
  },

  async setCapacity(playId, capacity) {
    set({ mutating: true, error: '' });
    try {
      const row = await get().ensureManifest(playId);
      const next: LoadingManifestRow = {
        ...row,
        truckCapacity: clampTruckCapacity(capacity),
        updatedAt: nowIso(),
        revision: ROW_REVISION,
      };
      await withRetry(() => putLoadingManifest(next));
      set({ manifest: next, mutating: false });
      await get().loadManifest(playId);
    } catch (error) {
      set({ mutating: false, error: error instanceof Error ? error.message : '容量写入失败' });
      throw error;
    }
  },

  async sealNextBatch(playId) {
    set({ mutating: true, error: '' });
    try {
      const row = await get().ensureManifest(playId);
      const scenes = await listScenesByPlay(playId);
      const roles = await listRolesByScenes(scenes.map((scene) => scene.id));

      // 已封车覆盖的场次不再进入尾部
      const sealedSceneIds = new Set<string>();
      row.sealedBatches.forEach((batch) => batch.sceneIds.forEach((id) => sealedSceneIds.add(id)));
      const tailScenes = scenes.filter((scene) => !sealedSceneIds.has(scene.id));
      const units: LoadUnit[] = buildLoadUnits(tailScenes, roles);
      const tailBatches = packUnits(units, row.truckCapacity, row.sealedBatches.length + 1);
      const first = tailBatches[0];
      if (!first) {
        set({ mutating: false });
        return;
      }

      const stamp = nowIso();
      const next: LoadingManifestRow = {
        ...row,
        updatedAt: stamp,
        revision: ROW_REVISION,
        sealedBatches: [
          ...row.sealedBatches,
          {
            batchNo: first.batchNo,
            sealedAt: stamp,
            capacityAtSeal: row.truckCapacity,
            sceneIds: first.units.map((unit) => unit.sceneId),
            units: cloneUnits(first.units),
            totalSlots: first.totalSlots,
          },
        ],
      };
      await withRetry(() => putLoadingManifest(next));
      set({ manifest: next, scenes, roles, mutating: false });
    } catch (error) {
      set({ mutating: false, error: error instanceof Error ? error.message : '封车失败' });
      throw error;
    }
  },

  async unsealLastBatch(playId) {
    set({ mutating: true, error: '' });
    try {
      const row = get().manifest ?? (await getLoadingManifestByPlay(playId));
      if (!row || row.sealedBatches.length === 0) {
        set({ mutating: false });
        return;
      }
      const next: LoadingManifestRow = {
        ...row,
        updatedAt: nowIso(),
        revision: ROW_REVISION,
        sealedBatches: row.sealedBatches.slice(0, -1),
      };
      await withRetry(() => putLoadingManifest(next));
      set({ manifest: next, mutating: false });
      await get().loadManifest(playId);
    } catch (error) {
      set({ mutating: false, error: error instanceof Error ? error.message : '解封失败' });
      throw error;
    }
  },

  async resetSealedBatches(playId) {
    set({ mutating: true, error: '' });
    try {
      const row = await get().ensureManifest(playId);
      const next: LoadingManifestRow = {
        ...row,
        updatedAt: nowIso(),
        revision: ROW_REVISION,
        sealedBatches: [],
      };
      await withRetry(() => putLoadingManifest(next));
      set({ manifest: next, mutating: false });
      await get().loadManifest(playId);
    } catch (error) {
      set({ mutating: false, error: error instanceof Error ? error.message : '清空封车记录失败' });
      throw error;
    }
  },
}));

