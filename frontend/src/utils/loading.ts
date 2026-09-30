/**
 * 巡演装车配批算法（纯函数）
 *
 * 规则：
 * 1. 每场的角色影件（头茬/身段/兵器）+ 该场所需影窗组成一个不可拆分的装车单元；
 * 2. 按场序（seq）顺序贪心装入当前车，单元不跨车——同场要用的头茬与双联影窗绝不会被拆到两辆车；
 * 3. 当前车装不下下一场时，整车封批，下一场顺延到新车；
 * 4. 单场箱位超过整车容量时，仍独占一批并标红「单车超载」，由调度另行处理；
 * 5. 已封车批次保留封车时快照，未封车部分从最后一批已封车之后按最新场次/影件/容量重排。
 */
import type { SceneRow } from './db';
import type { RoleRow } from './db';
import { PROP_PART_LABEL } from '../types/role';
import { SHADOW_SCREEN_LABEL } from '../types/scene';
import {
  DEFAULT_TRUCK_CAPACITY,
  PROP_PART_SLOTS,
  SCREEN_SLOTS,
  type LoadItem,
  type LoadUnit,
  type LoadingManifest,
  type PackedBatch,
  type LoadingManifestView,
} from '../types/loading';

/** 构建某一场的全部装车明细（影窗一件 + 各角色勾选影件） */
export function buildSceneItems(scene: SceneRow, roles: RoleRow[]): LoadItem[] {
  const items: LoadItem[] = [];
  for (const role of roles) {
    for (const part of role.propParts) {
      items.push({
        id: `${role.id}:${part}`,
        sceneId: scene.id,
        kind: part,
        label: `${PROP_PART_LABEL[part]}·${role.name}`,
        ownerName: role.name,
        slots: PROP_PART_SLOTS[part],
      });
    }
  }
  items.push({
    id: `screen:${scene.id}`,
    sceneId: scene.id,
    kind: 'screen',
    label: SHADOW_SCREEN_LABEL[scene.needsShadowScreen],
    ownerName: '影窗',
    slots: SCREEN_SLOTS[scene.needsShadowScreen],
  });
  return items;
}

/** 把场次 + 场次内角色汇总为一个不可拆分的装车单元 */
export function buildLoadUnit(scene: SceneRow, roles: RoleRow[]): LoadUnit {
  const items = buildSceneItems(scene, roles);
  const screenItem = items.find((item) => item.kind === 'screen');
  if (!screenItem) throw new Error('装车单元缺少影窗明细');
  return {
    sceneId: scene.id,
    seq: scene.seq,
    title: scene.title,
    screen: scene.needsShadowScreen,
    screenItem,
    items,
    totalSlots: items.reduce((sum, item) => sum + item.slots, 0),
  };
}

/** 按场序构建全部装车单元 */
export function buildLoadUnits(scenes: SceneRow[], roles: RoleRow[]): LoadUnit[] {
  const rolesByScene = new Map<string, RoleRow[]>();
  for (const role of roles) {
    const list = rolesByScene.get(role.sceneId);
    if (list) list.push(role);
    else rolesByScene.set(role.sceneId, [role]);
  }
  return [...scenes]
    .sort((a, b) => a.seq - b.seq)
    .map((scene) => buildLoadUnit(scene, rolesByScene.get(scene.id) ?? []));
}

/**
 * 顺序贪心装车：单元不跨车，装不下即顺延。
 * @param startBatchNo 起始车次（接续已封车批次编号）
 * @param capacity 当前每车容量
 * @returns 未封车批次（不含已封车快照）
 */
export function packUnits(units: LoadUnit[], capacity: number, startBatchNo: number): PackedBatch[] {
  const batches: PackedBatch[] = [];
  let current: LoadUnit[] = [];
  let used = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const batchNo = startBatchNo + batches.length;
    const delayed = batchNo > 1;
    const affectedSceneIds = delayed ? current.map((unit) => unit.sceneId) : [];
    batches.push({
      batchNo,
      status: 'waiting',
      units: current,
      totalSlots: used,
      capacity,
      delayed,
      affectedSceneIds,
      hasOverload: current.some((unit) => unit.totalSlots > capacity),
    });
    current = [];
    used = 0;
  };

  for (const unit of units) {
    if (current.length > 0 && used + unit.totalSlots > capacity) {
      flush();
    }
    current.push(unit);
    used += unit.totalSlots;
  }
  flush();
  return batches;
}

/** 把一个已封车快照批次转成展示视图 */
function toPackedSealed(batch: LoadingManifest['sealedBatches'][number]): PackedBatch {
  return {
    batchNo: batch.batchNo,
    status: 'sealed',
    units: batch.units,
    totalSlots: batch.totalSlots,
    capacity: batch.capacityAtSeal,
    sealedAt: batch.sealedAt,
    delayed: batch.batchNo > 1,
    affectedSceneIds: batch.batchNo > 1 ? batch.units.map((unit) => unit.sceneId) : [],
    hasOverload: batch.units.some((unit) => unit.totalSlots > batch.capacityAtSeal),
  };
}

/**
 * 生成整张装车单视图：已封车快照在前，未封车尾部从最后一批已封车之后重排。
 * 已封车覆盖的场次（含已被删除的场次快照）不再参与尾部重排。
 */
export function buildManifestView(
  manifest: LoadingManifest | null,
  scenes: SceneRow[],
  roles: RoleRow[],
): LoadingManifestView {
  const capacity = manifest?.truckCapacity ?? DEFAULT_TRUCK_CAPACITY;
  const sealed = (manifest?.sealedBatches ?? []).map(toPackedSealed);
  const sealedSceneIds = new Set<string>();
  for (const batch of sealed) {
    for (const unit of batch.units) sealedSceneIds.add(unit.sceneId);
  }

  const tailScenes = [...scenes].sort((a, b) => a.seq - b.seq).filter((scene) => !sealedSceneIds.has(scene.id));
  const tailUnits = buildLoadUnits(tailScenes, roles);
  const tail = packUnits(tailUnits, capacity, sealed.length + 1);

  const batches = [...sealed, ...tail];

  // 已封车快照里、当前场次已被删除的单元：保留快照但标灰提示
  const currentSceneIds = new Set(scenes.map((scene) => scene.id));
  for (const batch of batches) {
    for (const unit of batch.units) {
      unit.missing = !currentSceneIds.has(unit.sceneId);
    }
  }

  const waitingScenes = tailUnits;
  const delayedSceneIds = Array.from(
    new Set(batches.filter((batch) => batch.delayed).flatMap((batch) => batch.affectedSceneIds)),
  );

  return {
    capacity,
    exists: manifest !== null,
    batches,
    sealedCount: sealed.length,
    waitingCount: tail.length,
    waitingSceneCount: waitingScenes.length,
    totalUsedSlots: batches.reduce((sum, batch) => sum + batch.totalSlots, 0),
    delayedSceneIds,
  };
}

/** 深拷贝单元，避免封车快照与内存中的对象共享引用 */
export function cloneUnits(units: LoadUnit[]): LoadUnit[] {
  return units.map((unit) => ({
    ...unit,
    screenItem: { ...unit.screenItem },
    items: unit.items.map((item) => ({ ...item })),
  }));
}
