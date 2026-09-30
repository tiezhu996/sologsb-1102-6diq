/**
 * /plays/:id/loading 巡演装车单
 * 按场次顺序把「角色影件 + 所需影窗」配成不可拆车的批次，逐批写入装车：
 * 容量装不下则排队顺延到后一辆车并标明受影响场次；已封车批次保留、未封批次可重排。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Col,
  Empty,
  InputNumber,
  Progress,
  Row,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  CarOutlined,
  CopyOutlined,
  DownloadOutlined,
  LockOutlined,
  ReloadOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import { EmptyState } from '../components/common/EmptyState';
import { usePlayStore } from '../stores/playStore';
import { useLoadingStore } from '../stores/loadingStore';
import { ROUTES } from '../router';
import {
  BATCH_STATUS_LABEL,
  DEFAULT_VEHICLE_CAPACITY,
  LOAD_PLAN_STATUS_COLOR,
  LOAD_PLAN_STATUS_LABEL,
  MAX_VEHICLE_CAPACITY,
  MIN_VEHICLE_CAPACITY,
  SCREEN_VOLUME,
} from '../types/loading';
import { SHADOW_SCREEN_LABEL } from '../types/scene';
import { PROP_PART_LABEL } from '../types/role';
import { buildLoadingSheetText, copyText, exportLoadingCsvFile } from '../utils/export';
import type { LoadBatchRow } from '../utils/db';

export default function LoadingSheet() {
  const { id: playId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();

  const plays = usePlayStore((state) => state.plays);
  const selectPlay = usePlayStore((state) => state.selectPlay);
  const play = plays.find((item) => item.id === playId) ?? null;

  const plan = useLoadingStore((state) => state.plan);
  const batches = useLoadingStore((state) => state.batches);
  const sourceSig = useLoadingStore((state) => state.sourceSig);
  const sourceChanged = useLoadingStore((state) => state.sourceChanged);
  const loading = useLoadingStore((state) => state.loading);
  const writing = useLoadingStore((state) => state.writing);
  const progress = useLoadingStore((state) => state.progress);
  const error = useLoadingStore((state) => state.error);
  const loadPlanForPlay = useLoadingStore((state) => state.loadPlanForPlay);
  const generateOrReseat = useLoadingStore((state) => state.generateOrReseat);
  const continueWriting = useLoadingStore((state) => state.continueWriting);
  const sealVehicle = useLoadingStore((state) => state.sealVehicle);
  const unsealLastVehicle = useLoadingStore((state) => state.unsealLastVehicle);
  const rebuild = useLoadingStore((state) => state.rebuild);
  const clear = useLoadingStore((state) => state.clear);

  const [capacity, setCapacity] = useState<number>(DEFAULT_VEHICLE_CAPACITY);

  useEffect(() => {
    if (playId) selectPlay(playId);
  }, [playId, selectPlay]);

  useEffect(() => {
    if (play) void loadPlanForPlay(play);
    return () => clear();
  }, [play, loadPlanForPlay, clear]);

  // 已存在装车单时，容量控件以落库值为准
  useEffect(() => {
    if (plan) setCapacity(plan.vehicleCapacity);
  }, [plan?.vehicleCapacity]);

  const vehicles = useMemo(() => groupByVehicle(batches), [batches]);
  const affectedScenes = useMemo(
    () => new Set([...(plan?.delayedSceneIds ?? []), ...batches.filter((b) => b.delayed || b.overCapacity).map((b) => b.sceneId)]),
    [plan, batches],
  );
  const overCapacityBatches = batches.filter((batch) => batch.overCapacity);
  const sealedVehicleNos = useMemo(
    () =>
      [...new Set(batches.filter((batch) => batch.status === 'sealed').map((batch) => batch.vehicleNo))].sort(
        (a, b) => a - b,
      ),
    [batches],
  );
  const latestSealedVehicle = sealedVehicleNos[sealedVehicleNos.length - 1] ?? null;

  if (!play) {
    return (
      <div className="gb-panel">
        <EmptyState
          title="未找到该剧目"
          description="剧目可能已被删除，请回到剧目库重新选择。"
          actionText="回到剧目库"
          onAction={() => navigate(ROUTES.plays)}
        />
      </div>
    );
  }

  const handleGenerate = () => {
    const nextCapacity = clampCapacity(capacity);
    setCapacity(nextCapacity);
    void generateOrReseat(play, nextCapacity);
  };

  const handleContinue = () => void continueWriting(play);

  const handleSeal = (vehicleNo: number) => {
    void sealVehicle(play, vehicleNo).then(() => message.success(`第 ${vehicleNo} 车已封车，后续重排会保留该车`));
  };

  const handleUnseal = () => {
    if (latestSealedVehicle === null) return;
    void unsealLastVehicle(play).then(() => message.success(`第 ${latestSealedVehicle} 车已解封，未封批次已重排`));
  };

  const handleRebuild = () => {
    void rebuild(play, clampCapacity(capacity)).then(() => message.success('装车单已按当前容量重新生成'));
  };

  const handleExportCsv = () => {
    if (!plan) return;
    const filename = exportLoadingCsvFile(play, batches);
    message.success(`已导出：${filename}`);
  };

  const handleCopyText = async () => {
    if (!plan) return;
    const text = buildLoadingSheetText(play, plan, batches);
    const ok = await copyText(text);
    if (ok) message.success('装车单文本已复制，可直接发给装车师傅');
    else message.error('剪贴板不可用，请改用 CSV 导出');
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-panel-title">
          <Space size={10} wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.scenes(play.id))}>
              场次拆分
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              巡演装车单 · {play.title}
            </Typography.Title>
            {plan ? <Tag color={LOAD_PLAN_STATUS_COLOR[plan.status]}>{LOAD_PLAN_STATUS_LABEL[plan.status]}</Tag> : null}
          </Space>
          <Space wrap>
            <Button icon={<DownloadOutlined />} disabled={!plan || writing} onClick={handleExportCsv}>
              导出装车 CSV
            </Button>
            <Button icon={<CopyOutlined />} disabled={!plan || writing} onClick={() => void handleCopyText()}>
              复制文本
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="总车数" value={plan?.totalVehicles ?? 0} suffix="辆" prefix={<CarOutlined />} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="装车批次（场次）" value={batches.length} suffix={`批`} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="已封车" value={sealedVehicleNos.length} suffix={`/ ${plan?.totalVehicles ?? 0} 辆`} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="受顺延 / 超容影响场次" value={affectedScenes.size} suffix="场" />
          </Col>
        </Row>

        <div
          style={{
            marginTop: 14,
            padding: '12px 14px',
            background: '#fbf3e4',
            border: '1px solid rgba(201,150,60,0.4)',
            borderRadius: 8,
          }}
        >
          <Space wrap size={12}>
            <Typography.Text strong>每车容量</Typography.Text>
            <InputNumber
              min={MIN_VEHICLE_CAPACITY}
              max={MAX_VEHICLE_CAPACITY}
              value={capacity}
              onChange={(value) => setCapacity(typeof value === 'number' ? value : DEFAULT_VEHICLE_CAPACITY)}
              disabled={writing}
              addonAfter="单位"
              style={{ width: 130 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              影窗 {SCREEN_VOLUME.small}/{SCREEN_VOLUME.standard}/{SCREEN_VOLUME.large}/{SCREEN_VOLUME.twin} 单位（小/标准/大/双联），
              头茬、兵器各 1、身段 2；一场一批不可拆车。
            </Typography.Text>
            {!plan ? (
              <Button type="primary" icon={<CarOutlined />} loading={writing} onClick={handleGenerate}>
                生成装车单
              </Button>
            ) : (
              <>
                <Tooltip title="已封车批次保留，仅对未封车批次按当前容量与最新场次/影件重新装车">
                  <Button type="primary" ghost icon={<ReloadOutlined />} loading={writing} onClick={handleGenerate}>
                    未封批次重排
                  </Button>
                </Tooltip>
                <Tooltip title="删除全部批次（含已封车），按当前容量重新生成">
                  <Button icon={<ReloadOutlined />} disabled={writing} onClick={handleRebuild}>
                    整单重建
                  </Button>
                </Tooltip>
                {latestSealedVehicle !== null ? (
                  <Button icon={<UnlockOutlined />} disabled={writing} onClick={handleUnseal}>
                    解封第 {latestSealedVehicle} 车
                  </Button>
                ) : null}
              </>
            )}
          </Space>
        </div>

        {plan?.status === 'failed' ? (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            message="装车写入中断"
            description={
              <Space direction="vertical" size={6}>
                <Typography.Text>{plan.errorMessage || '有批次未能写入本地存储。'}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  断点已记录，已写入批次不会重复；点击「从最后一批续写」即可继续。
                </Typography.Text>
                <Button type="primary" size="small" loading={writing} onClick={handleContinue}>
                  从最后一批续写
                </Button>
              </Space>
            }
          />
        ) : null}

        {writing ? (
          <div style={{ marginTop: 12 }}>
            <Progress
              percent={progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 10}
              status="active"
              strokeColor="#7a1f1f"
              format={() => `已写入 ${progress.done} / ${progress.total || '…'} 批`}
            />
          </div>
        ) : null}

        {error && !writing ? (
          <Alert style={{ marginTop: 12 }} type="error" showIcon message={error} />
        ) : null}

        {plan && sourceChanged && plan.status !== 'failed' ? (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message="场次、角色或影件有改动"
            description="已封车批次保留不变；点击「未封批次重排」即可按最新数据重排未封车批次，并在单上标出受影响场次。"
          />
        ) : null}

        {overCapacityBatches.length > 0 ? (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message={`有 ${overCapacityBatches.length} 个批次单批体积超过单车容量`}
            description={`影件不可拆散，相关批次独占一车：${overCapacityBatches
              .map((batch) => `第${batch.seq}场（${batch.volume} 单位）`)
              .join('、')}。可调大每车容量或安排拆演。`}
          />
        ) : null}
      </div>

      {loading ? (
        <div className="gb-panel">
          <Empty description="正在读取装车单…" />
        </div>
      ) : !plan ? (
        <div className="gb-panel">
          <EmptyState
            title="还没有巡演装车单"
            description="按场次顺序把角色影件与所需影窗配成批次：每车容量有限，装不下的批次自动顺延到后一辆，并标明受影响场次。"
            actionText="生成装车单"
            onAction={handleGenerate}
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                旧剧目同样可生成：批次完全由已建档的场次与角色影件派生。源签名 {sourceSig ? `（${sourceSig.slice(0, 8)}）` : ''}
              </Typography.Text>
            }
          />
        </div>
      ) : batches.length === 0 ? (
        <div className="gb-panel">
          <EmptyState
            title="这出戏没有可装车的场次"
            description="先到「场次拆分」建档并登记角色影件，再回来生成装车单。"
            actionText="去场次拆分"
            onAction={() => navigate(ROUTES.scenes(play.id))}
          />
        </div>
      ) : (
        <Row gutter={[16, 16]}>
          {vehicles.map((vehicle) => (
            <Col key={vehicle.vehicleNo} xs={24} lg={12}>
              <VehicleCard
                vehicleNo={vehicle.vehicleNo}
                capacity={plan.vehicleCapacity}
                batches={vehicle.batches}
                sealed={vehicle.sealed}
                canUnseal={vehicle.vehicleNo === latestSealedVehicle}
                writing={writing}
                onSeal={() => handleSeal(vehicle.vehicleNo)}
                onUnseal={handleUnseal}
                onOpenRoles={(sceneId) => navigate(ROUTES.roles(sceneId))}
              />
            </Col>
          ))}
        </Row>
      )}
    </Space>
  );
}

interface VehicleGroup {
  vehicleNo: number;
  batches: LoadBatchRow[];
  used: number;
  sealed: boolean;
}

function groupByVehicle(rows: LoadBatchRow[]): VehicleGroup[] {
  const map = new Map<number, LoadBatchRow[]>();
  [...rows]
    .sort((a, b) => a.orderInVehicle - b.orderInVehicle || a.seq - b.seq)
    .forEach((row) => {
      map.set(row.vehicleNo, [...(map.get(row.vehicleNo) ?? []), row]);
    });
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([vehicleNo, vehicleBatches]) => ({
      vehicleNo,
      batches: vehicleBatches,
      used: vehicleBatches.reduce((sum, batch) => sum + batch.volume, 0),
      sealed: vehicleBatches.every((batch) => batch.status === 'sealed'),
    }));
}

function clampCapacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VEHICLE_CAPACITY;
  return Math.min(MAX_VEHICLE_CAPACITY, Math.max(MIN_VEHICLE_CAPACITY, Math.round(value)));
}

interface VehicleCardProps {
  vehicleNo: number;
  capacity: number;
  batches: LoadBatchRow[];
  sealed: boolean;
  canUnseal: boolean;
  writing: boolean;
  onSeal: () => void;
  onUnseal: () => void;
  onOpenRoles: (sceneId: string) => void;
}

function VehicleCard({
  vehicleNo,
  capacity,
  batches,
  sealed,
  canUnseal,
  writing,
  onSeal,
  onUnseal,
  onOpenRoles,
}: VehicleCardProps) {
  const used = batches.reduce((sum, batch) => sum + batch.volume, 0);
  const percent = Math.min(100, Math.round((used / capacity) * 100));
  const overfilled = used > capacity;
  return (
    <div
      className="gb-panel"
      style={{
        borderColor: sealed ? '#7a1f1f' : overfilled ? '#cf1322' : undefined,
        borderWidth: sealed ? 2 : 1,
        background: sealed ? '#fdf6ec' : undefined,
      }}
    >
      <div className="gb-panel-title">
        <Space size={8} wrap>
          <CarOutlined style={{ color: '#7a1f1f' }} />
          <Typography.Text strong style={{ fontSize: 16 }}>
            第 {vehicleNo} 车
          </Typography.Text>
          <Tag color={sealed ? '#7a1f1f' : 'default'}>
            {sealed ? <span><LockOutlined /> 已封车</span> : BATCH_STATUS_LABEL.pending}
          </Tag>
          <Tag color={overfilled ? 'error' : 'gold'}>
            {used} / {capacity} 单位
          </Tag>
        </Space>
        <Space>
          {sealed ? (
            canUnseal ? (
              <Button size="small" icon={<UnlockOutlined />} disabled={writing} onClick={onUnseal}>
                解封
              </Button>
            ) : (
              <Tooltip title="只能解封最后一辆已封车，请先解封其后的车辆">
                <Button size="small" icon={<LockOutlined />} disabled>
                  已封
                </Button>
              </Tooltip>
            )
          ) : (
            <Button size="small" type="primary" ghost icon={<LockOutlined />} loading={writing} onClick={onSeal}>
              封车
            </Button>
          )}
        </Space>
      </div>

      <Progress percent={percent} strokeColor={overfilled ? '#cf1322' : '#c9963c'} showInfo={false} />

      <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 8 }}>
        {batches.map((batch) => (
          <BatchCard key={batch.id} batch={batch} disabled={sealed} onOpenRoles={() => onOpenRoles(batch.sceneId)} />
        ))}
      </Space>
    </div>
  );
}

function BatchCard({
  batch,
  disabled,
  onOpenRoles,
}: {
  batch: LoadBatchRow;
  disabled: boolean;
  onOpenRoles: () => void;
}) {
  const partsByRole = new Map<string, LoadBatchRow['items']>();
  batch.items.forEach((item) => {
    partsByRole.set(item.roleName, [...(partsByRole.get(item.roleName) ?? []), item]);
  });

  return (
    <div
      style={{
        border: `1px solid ${batch.overCapacity ? 'rgba(207,19,34,0.5)' : 'rgba(43,26,18,0.14)'}`,
        background: batch.delayed || batch.overCapacity ? '#fff7f5' : '#fffdf8',
        borderRadius: 8,
        padding: '10px 12px',
      }}
    >
      <Space wrap size={6} style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space size={6} wrap>
          <Typography.Text strong>
            第 {batch.seq} 场 · {batch.sceneTitle}
          </Typography.Text>
          <Tag>{SHADOW_SCREEN_LABEL[batch.screenSpec]}</Tag>
          <Tag color="gold">{batch.volume} 单位</Tag>
          {batch.delayed ? <Tag color="volcano">顺延装车</Tag> : null}
          {batch.overCapacity ? <Tag color="error">超出单车容量</Tag> : null}
          {batch.status === 'sealed' ? <Tag color="#7a1f1f">已封车</Tag> : null}
        </Space>
        <Button type="link" size="small" disabled={disabled} onClick={onOpenRoles}>
          查看角色影件
        </Button>
      </Space>

      <div style={{ marginTop: 6 }}>
        {[...partsByRole.entries()].map(([roleName, items]) => (
          <Tag key={roleName} style={{ marginBottom: 4 }}>
            {roleName}：{items.map((item) => PROP_PART_LABEL[item.part]).join('／')}
          </Tag>
        ))}
        {batch.items.length === 0 ? <Typography.Text type="secondary">该场未登记影件，仅装影窗</Typography.Text> : null}
      </div>

      {batch.note ? (
        <Typography.Text type={batch.overCapacity ? 'danger' : 'warning'} style={{ fontSize: 12 }}>
          {batch.note}
        </Typography.Text>
      ) : null}
    </div>
  );
}
