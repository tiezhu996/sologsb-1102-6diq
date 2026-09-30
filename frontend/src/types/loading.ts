/**
 * 巡演装车单（LoadingManifest）数据模型
 * 按场次顺序把角色影件（头茬/身段/兵器）与所需影窗配成装车批次：
 * 同一场次的全部影件与影窗视为不可拆分单元，必须装在同一辆车；
 * 车容量不足时整批顺延下一辆，并在顺延批次上写明受影响场次。
 *
 * 已封车批次以快照形式保留，场次/角色/影件改动后只重排未封车部分。
 */
import type { PropPart } from './role';
import type { ShadowScreenSpec } from './scene';

/** 装车明细行类型：影件拆件 / 影窗 */
export type LoadItemKind = PropPart | 'screen';

/** 一件待装影件（或一扇影窗） */
export interface LoadItem {
  /** 行内唯一键：影件用 `${roleId}:${part}`，影窗用 `screen:${sceneId}` */
  id: string;
  /** 所属场次 id */
  sceneId: string;
  /** 明细类型 */
  kind: LoadItemKind;
  /** 明细名称，如「头茬·白娘子」「双联影窗 · 2×1.6m」 */
  label: string;
  /** 归属：角色名或「影窗」 */
  ownerName: string;
  /** 占用箱位 */
  slots: number;
}

/**
 * 场次装车单元（不可拆分）：一场的全部影件 + 该场所需影窗。
 * 同时作为封车快照结构持久化，字段必须保持可 JSON 序列化。
 */
export interface LoadUnit {
  sceneId: string;
  /** 封车/配批当时的场序（快照保留，重排后可能与当前场序不同） */
  seq: number;
  title: string;
  /** 该场所需影窗规格 */
  screen: ShadowScreenSpec;
  /** 影窗一件（每场恰好一扇） */
  screenItem: LoadItem;
  /** 角色影件明细 */
  items: LoadItem[];
  /** 本场合计箱位 */
  totalSlots: number;
  /** 该场次是否已在当前剧目中被删除（仅封车快照可能出现） */
  missing?: boolean;
}

/** 已封车批次（持久化快照） */
export interface SealedBatch {
  /** 批次（车）序号，从 1 开始，全场连续 */
  batchNo: number;
  /** 封车时间（ISO 字符串） */
  sealedAt: string;
  /** 封车时采用的每车容量 */
  capacityAtSeal: number;
  /** 本批覆盖的场次 id */
  sceneIds: string[];
  /** 封车瞬间的场次单元快照（此后场次/影件改动不影响本批） */
  units: LoadUnit[];
  /** 本批实装箱位 */
  totalSlots: number;
}

/** 装车单表头：每剧目一条 */
export interface LoadingManifest {
  /** 主键，uuid */
  id: string;
  /** 所属剧目 id（一剧一单） */
  playId: string;
  /** 每辆车容量（箱位） */
  truckCapacity: number;
  /** 已封车批次，按 batchNo 升序 */
  sealedBatches: SealedBatch[];
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------ 容量计量 ------------------------------ */

/** 各影件拆件占用箱位：身段最占地方，头茬与兵器较轻巧 */
export const PROP_PART_SLOTS: Record<PropPart, number> = {
  toucha: 1,
  shenduan: 2,
  bingqi: 1,
};

/** 各规格影窗占用箱位：双联影窗最大 */
export const SCREEN_SLOTS: Record<ShadowScreenSpec, number> = {
  small: 2,
  standard: 3,
  large: 5,
  twin: 8,
};

/** 默认每车容量（箱位） */
export const DEFAULT_TRUCK_CAPACITY = 20;
export const MIN_TRUCK_CAPACITY = 4;
export const MAX_TRUCK_CAPACITY = 120;

/** 规整容量输入 */
export function clampTruckCapacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TRUCK_CAPACITY;
  return Math.min(MAX_TRUCK_CAPACITY, Math.max(MIN_TRUCK_CAPACITY, Math.round(value)));
}

/** 装车批次展示视图（已封车 + 未封车重排结果） */
export interface PackedBatch {
  batchNo: number;
  status: 'sealed' | 'waiting';
  units: LoadUnit[];
  totalSlots: number;
  /** 本批适用的容量（已封车按封车时容量，未封车按当前容量） */
  capacity: number;
  sealedAt?: string;
  /** 是否为顺延批次（batchNo > 1：受前车容量限制排队而来） */
  delayed: boolean;
  /** 受影响场次（顺延批次内全部场次，首个为触发顺延的边界场次） */
  affectedSceneIds: string[];
  /** 是否含单场超出全车容量的单元 */
  hasOverload: boolean;
}

/** 整张装车单的派生视图 */
export interface LoadingManifestView {
  capacity: number;
  /** 库中是否已存在装车单行（未封过车、未改过容量时为懒建档） */
  exists: boolean;
  batches: PackedBatch[];
  sealedCount: number;
  waitingCount: number;
  /** 待装（未封车）场次数 */
  waitingSceneCount: number;
  /** 全部批次合计实装箱位 */
  totalUsedSlots: number;
  /** 顺延影响到的场次 id（去重） */
  delayedSceneIds: string[];
}
