/**
 * 巡演装车纯算法：批次归集、源签名、按场序装车（next-fit）、未封批次重排。
 *
 * 规则：
 * - 一场一个批次：该场全部角色影件（头茬/身段/兵器）与所需影窗同批，批次不可拆车；
 * - 按场序依次装车，单车容量有限：当前车装不下时封当前车、顺延开下一辆；
 * - 单批体积超过单车容量时批次仍独占一辆（影件不可拆散），标记 overCapacity 告警；
 * - 重排只处理「待封车」批次，已封车批次保留，并以最大已封车号为重排起点；
 * - 纯函数，不碰 IndexedDB，便于单测。
 */
import type { Scene } from '../types/scene';
import type { ShadowRole } from '../types/role';
import { PART_VOLUME, SCREEN_VOLUME } from '../types/loading';
import type { LoadBatch } from '../types/loading';

/** 一场的归集输入（场次 + 该场全部角色，按角色登记顺序） */
export interface PackedSceneInput {
  scene: Scene;
  roles: ShadowRole[];
}

/** 装车结果中的一批（不含 id / 状态 / 落库时间，由持久化层补齐） */
export interface PackedBatch {
  sceneId: string;
  playId: string;
  seq: number;
  sceneTitle: string;
  roleNames: string[];
  screenSpec: Scene['needsShadowScreen'];
  items: LoadBatch['items'];
  volume: number;
  vehicleNo: number;
  orderInVehicle: number;
  delayed: boolean;
  overCapacity: boolean;
  note: string;
}

export interface PackResult {
  /** 按场序排列的批次（车号 / 车中次序已填） */
  batches: PackedBatch[];
  /** 总车数 */
  totalVehicles: number;
  /** 因前车装满而顺延到后车的场次 id（受影响场次） */
  delayedSceneIds: string[];
  /** 单批超容的场次 id */
  overCapacitySceneIds: string[];
}

/** 计算单场批次体积：影窗 + 全部影件 */
export function sceneVolume(scene: Scene, roles: ShadowRole[]): number {
  const screen = SCREEN_VOLUME[scene.needsShadowScreen];
  const props = roles.reduce(
    (sum, role) => sum + role.propParts.reduce((acc, part) => acc + PART_VOLUME[part], 0),
    0,
  );
  return screen + props;
}

/**
 * 源数据签名：场次（序号/影窗）与角色影件组合发生任何改动后签名变化，
 * 装车单据此判断「场次、角色或影件改动后，未封车批次需要重排」。
 */
export function buildSourceSignature(scenes: Scene[], roles: ShadowRole[]): string {
  const scenePart = scenes
    .map((scene) => `${scene.id}:${scene.seq}:${scene.needsShadowScreen}`)
    .sort()
    .join('|');
  const rolePart = roles
    .map(
      (role) =>
        `${role.sceneId}:${role.name}:${[...role.propParts].sort().join('/')}`,
    )
    .sort()
    .join('|');
  return hash32(`${scenePart}#${rolePart}`);
}

/** 轻量 32 位哈希（FNV-1a），仅用于本地变更比对 */
function hash32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 按场序装车：批次不可拆，装不下就顺延开下一辆 */
export function packBatches(inputs: PackedSceneInput[], capacity: number, startVehicleNo: number): PackResult {
  const sorted = [...inputs].sort((a, b) => a.scene.seq - b.scene.seq);
  const batches: PackedBatch[] = [];
  const delayedSceneIds: string[] = [];
  const overCapacitySceneIds: string[] = [];

  let vehicleNo = Math.max(1, startVehicleNo);
  let used = 0;
  let orderInVehicle = 0;

  sorted.forEach(({ scene, roles }) => {
    const volume = sceneVolume(scene, roles);
    const overCapacity = volume > capacity;
    // 当前车已有货物且本批装不下即顺延开下一辆：
    // 普通批次受容量约束；超容批次自身已超过容量，只要前车有货就必须独占新车
    const mustRoll = used > 0 && used + volume > capacity;
    const previousUsed = used;
    if (mustRoll) {
      vehicleNo += 1;
      used = 0;
      orderInVehicle = 0;
    }

    const delayed = mustRoll;
    if (delayed) delayedSceneIds.push(scene.id);
    if (overCapacity) overCapacitySceneIds.push(scene.id);

    const note = overCapacity
      ? `本批 ${volume} 单位，超出单车容量 ${capacity}：影件不可拆散，${mustRoll ? '自前车顺延并' : ''}独占第 ${vehicleNo} 车，需调大容量或拆演`
      : delayed
        ? `前车已装 ${previousUsed}/${capacity} 单位装不下，顺延至第 ${vehicleNo} 车`
        : '';

    batches.push({
      sceneId: scene.id,
      playId: scene.playId,
      seq: scene.seq,
      sceneTitle: scene.title,
      roleNames: roles.map((role) => role.name),
      screenSpec: scene.needsShadowScreen,
      items: roles.flatMap((role) =>
        role.propParts.map((part) => ({ roleName: role.name, roleType: role.roleType, part })),
      ),
      volume,
      vehicleNo,
      orderInVehicle,
      delayed,
      overCapacity,
      note,
    });

    // 超容批次视为把本车装满：其后的正常批次顺延开新车
    used = overCapacity ? capacity : used + volume;
    orderInVehicle += 1;
  });

  return {
    batches,
    totalVehicles: batches.length > 0 ? vehicleNo - startVehicleNo + 1 : 0,
    delayedSceneIds,
    overCapacitySceneIds,
  };
}

/**
 * 未封车批次重排：已封车批次保留，待封车批次从「最大已封车号 + 1」开始
 * 按场序重新装车。受影响场次即重排后落在非起始车上的待封场次。
 */
export function repackPending(
  currentScenes: Scene[],
  currentRoles: ShadowRole[],
  sealedBatches: LoadBatch[],
  capacity: number,
): PackResult {
  const sealedSceneIds = new Set(sealedBatches.map((batch) => batch.sceneId));
  const inputs: PackedSceneInput[] = [...currentScenes]
    .sort((a, b) => a.seq - b.seq)
    .filter((scene) => !sealedSceneIds.has(scene.id))
    .map((scene) => ({ scene, roles: currentRoles.filter((role) => role.sceneId === scene.id) }));

  const maxSealedVehicle = sealedBatches.reduce((max, batch) => Math.max(max, batch.vehicleNo), 0);
  const startVehicleNo = maxSealedVehicle + 1;
  const result = packBatches(inputs, capacity, startVehicleNo);
  // 重排语境下，凡未落在起始车（紧接已封车的第一辆）的待封批次都是受影响场次
  result.delayedSceneIds = result.batches
    .filter((batch) => batch.vehicleNo > startVehicleNo)
    .map((batch) => batch.sceneId);
  result.totalVehicles = Math.max(
    maxSealedVehicle,
    result.batches.reduce((max, batch) => Math.max(max, batch.vehicleNo), 0),
  );
  return result;
}
