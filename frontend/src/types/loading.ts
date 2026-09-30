/**
 * 巡演装车单（LoadPlan / LoadBatch）数据模型
 *
 * 一个场次生成一个「装车批次」：该场全部角色影件与所需影窗同批，
 * 批次不可拆车，避免同场要用的头茬与双联影窗被分到两辆车。
 * 批次按场序依次装车，每车容量有限，装不下的批次排队顺延到后车。
 */
import type { ShadowScreenSpec } from './scene';
import type { PropPart, RoleType } from './role';

/** 装车单写入状态：写入中 / 已完成 / 写入中断（可从最后一批继续） */
export type LoadPlanStatus = 'building' | 'ready' | 'failed';

/** 批次封车状态：待封车（可随场次/影件改动重排）/ 已封车（保留不动） */
export type BatchSealStatus = 'pending' | 'sealed';

/** 一件影件：某角色的某个拆件部位 */
export interface BatchItem {
  /** 角色名快照，如「白娘子」 */
  roleName: string;
  /** 行当快照 */
  roleType: RoleType;
  /** 拆件部位：头茬 / 身段 / 兵器 */
  part: PropPart;
}

/** 装车批次：一场一批 */
export interface LoadBatch {
  /** 主键，确定性 id：batch:{playId}:{sceneId} */
  id: string;
  /** 所属剧目 id */
  playId: string;
  /** 来源场次 id */
  sceneId: string;
  /** 场序快照（从 1 开始） */
  seq: number;
  /** 场次标题快照 */
  sceneTitle: string;
  /** 该场出场角色名快照 */
  roleNames: string[];
  /** 该场所需影窗规格快照 */
  screenSpec: ShadowScreenSpec;
  /** 影件清单（角色 × 拆件部位） */
  items: BatchItem[];
  /** 本批装车单位合计（影窗 + 影件） */
  volume: number;
  /** 待封车 / 已封车 */
  status: BatchSealStatus;
  /** 车号，从 1 开始 */
  vehicleNo: number;
  /** 在本车中的装车次序，从 0 开始 */
  orderInVehicle: number;
  /** 是否因前车装满而顺延到本车 */
  delayed: boolean;
  /** 是否单批体积超过单车容量（批次不可拆，独占一车并告警） */
  overCapacity: boolean;
  /** 装车备注（顺延 / 超容说明） */
  note: string;
  /** 封车时间，未封车为 null */
  sealedAt: string | null;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 最近修改时间（ISO 字符串） */
  updatedAt: string;
}

/** 一个剧目的巡演装车单（每剧目一份） */
export interface LoadPlan {
  /** 主键，确定性 id：plan:{playId} */
  id: string;
  /** 所属剧目 id */
  playId: string;
  /** 每车容量（装车单位） */
  vehicleCapacity: number;
  /** 写入状态 */
  status: LoadPlanStatus;
  /** 最后一个已确认写入的批次 id（写入失败后从其后继续） */
  lastWrittenBatchId: string | null;
  /** 场次 / 角色 / 影件源数据签名，与当前数据不一致时未封批次需重排 */
  sourceSig: string;
  /** 全部批次 id，按场序排列（含已封车批次） */
  batchOrder: string[];
  /** 总车数 */
  totalVehicles: number;
  /** 顺延批次对应的场次 id（受影响场次） */
  delayedSceneIds: string[];
  /** 最近一次写入错误信息 */
  errorMessage: string;
  /** 最近一次写入失败时间 */
  failedAt: string | null;
  /** 本次装车方案生成时间（重排不重置） */
  builtAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 各影窗规格占用的装车单位 */
export const SCREEN_VOLUME: Record<ShadowScreenSpec, number> = {
  small: 2,
  standard: 3,
  large: 4,
  twin: 6,
};

/** 各拆件部位占用的装车单位（身段最大，头茬次之，兵器最小） */
export const PART_VOLUME: Record<PropPart, number> = {
  toucha: 1,
  shenduan: 2,
  bingqi: 1,
};

/** 默认每车容量（装车单位） */
export const DEFAULT_VEHICLE_CAPACITY = 16;
/** 容量可调范围 */
export const MIN_VEHICLE_CAPACITY = 4;
export const MAX_VEHICLE_CAPACITY = 60;

export const LOAD_PLAN_ID_PREFIX = 'plan:';
export const LOAD_BATCH_ID_PREFIX = 'batch:';

/** 装车单确定性主键（同剧目反复重建仍为同一行） */
export function loadPlanId(playId: string): string {
  return `${LOAD_PLAN_ID_PREFIX}${playId}`;
}

/** 批次确定性主键（同场次重建仍为同一行，已封批次据此保留） */
export function loadBatchId(playId: string, sceneId: string): string {
  return `${LOAD_BATCH_ID_PREFIX}${playId}:${sceneId}`;
}

export const LOAD_PLAN_STATUS_LABEL: Record<LoadPlanStatus, string> = {
  building: '写入中',
  ready: '已完成',
  failed: '写入中断',
};

export const LOAD_PLAN_STATUS_COLOR: Record<LoadPlanStatus, string> = {
  building: 'processing',
  ready: 'success',
  failed: 'error',
};

export const BATCH_STATUS_LABEL: Record<BatchSealStatus, string> = {
  pending: '待封车',
  sealed: '已封车',
};
