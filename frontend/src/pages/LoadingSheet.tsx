/**
 * /plays/:id/loading 巡演装车单
 * 按场次顺序把角色影件与所需影窗配成车批：同场不拆车、容量不足顺延；
 * 已封车批次保留快照，未封车部分在场次/影件/容量改动后自动重排。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  InputNumber,
  Popconfirm,
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
  ClearOutlined,
  DownloadOutlined,
  LockOutlined,
  ReloadOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import { EmptyState } from '../components/common/EmptyState';
import { usePlayStore } from '../stores/playStore';
import { useLoadingStore } from '../stores/loadingStore';
import { ROUTES } from '../router';
import { SHADOW_SCREEN_LABEL } from '../types/scene';
import {
  MAX_TRUCK_CAPACITY,
  MIN_TRUCK_CAPACITY,
  type LoadItem,
  type LoadUnit,
  type PackedBatch,
} from '../types/loading';
import { buildManifestView } from '../utils/loading';
import { exportLoadingCsvFile } from '../utils/export';
import { formatStamp } from '../utils/uuid';

export default function LoadingSheet() {
  const { id: playId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();

  const plays = usePlayStore((state) => state.plays);
  const selectPlay = usePlayStore((state) => state.selectPlay);

  const manifest = useLoadingStore((state) => state.manifest);
  const scenes = useLoadingStore((state) => state.scenes);
  const roles = useLoadingStore((state) => state.roles);
  const loading = useLoadingStore((state) => state.loading);
  const mutating = useLoadingStore((state) => state.mutating);
  const error = useLoadingStore((state) => state.error);
  const loadManifest = useLoadingStore((state) => state.loadManifest);
  const setCapacity = useLoadingStore((state) => state.setCapacity);
  const sealNextBatch = useLoadingStore((state) => state.sealNextBatch);
  const unsealLastBatch = useLoadingStore((state) => state.unsealLastBatch);
  const resetSealedBatches = useLoadingStore((state) => state.resetSealedBatches);

  const [capacityDraft, setCapacityDraft] = useState<number | null>(null);

  const play = plays.find((item) => item.id === playId) ?? null;

  useEffect(() => {
    if (playId) {
      selectPlay(playId);
      void loadManifest(playId);
    }
  }, [playId, selectPlay, loadManifest]);

  useEffect(() => {
    if (error) message.error(error);
  }, [error, message]);

  const view = useMemo(() => buildManifestView(manifest, scenes, roles), [manifest, scenes, roles]);

  // 容量输入框：以库中值（或默认值）为基准，编辑时只改本地草稿
  const capacityValue = capacityDraft ?? view.capacity;
  useEffect(() => {
    if (capacityDraft !== null && capacityDraft === view.capacity) setCapacityDraft(null);
  }, [capacityDraft, view.capacity]);

  const capacityDirty = capacityDraft !== null && capacityDraft !== view.capacity;

  const handleApplyCapacity = async () => {
    if (capacityDraft === null) return;
    try {
      await setCapacity(playId, capacityDraft);
      message.success('每车容量已更新，未封车批次已重排');
      setCapacityDraft(null);
    } catch {
      /* error 已在 store 记录并提示 */
    }
  };

  const handleSeal = async () => {
    try {
      await sealNextBatch(playId);
      message.success('第一辆待装车已封车，后续批次顺延');
    } catch {
      /* 同上 */
    }
  };

  const handleUnseal = async () => {
    try {
      await unsealLastBatch(playId);
      message.success('已解开最后一辆封车，该部分重新参与排队');
    } catch {
      /* 同上 */
    }
  };

  const handleReset = async () => {
    try {
      await resetSealedBatches(playId);
      message.success('封车记录已清空，全部场次重新排队');
    } catch {
      /* 同上 */
    }
  };

  const handleRefresh = () => {
    void loadManifest(playId);
    message.info('已按最新场次、角色与影件重排未封车批次');
  };

  const handleExport = () => {
    if (!play) return;
    const filename = exportLoadingCsvFile(play, view);
    message.success(`装车单已导出：${filename}`);
  };

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

  const hasWaiting = view.waitingCount > 0;
  const hasSealed = view.sealedCount > 0;
  const usedSlotsOfAll = view.totalUsedSlots;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-brand-bar" />
        <div className="gb-panel-title">
          <Space size={10} wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.scenes(playId))}>
              返回场次
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              巡演装车单 · {play.title}
            </Typography.Title>
            {manifest ? <Tag color="green">已建档</Tag> : <Tag color="gold">旧剧目 · 首次操作自动建档</Tag>}
          </Space>
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={handleRefresh} loading={loading}>
              按最新改动重排
            </Button>
            <Button icon={<DownloadOutlined />} disabled={view.batches.length === 0} onClick={handleExport}>
              导出装车单
            </Button>
          </Space>
        </div>

        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          每场的头茬、身段、兵器与该场所需影窗（含双联影窗）配成一个不可拆分批次，同场影件与影窗不会分车；
          当前车装不下时整批顺延下一辆。已封车批次保留封车快照，场次、角色或影件改动后仅重排未封车部分，可继续从最后一批封车处装车。
        </Typography.Paragraph>

        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="车批总数" value={view.batches.length} suffix="辆" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="已封车 / 待装" value={`${view.sealedCount} / ${view.waitingCount}`} suffix="辆" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="待装场次" value={view.waitingSceneCount} suffix="场" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="全程实装箱位" value={usedSlotsOfAll} suffix="箱位" />
          </Col>
        </Row>

        <Space wrap size={12} style={{ marginTop: 14 }}>
          <Typography.Text strong>每车容量：</Typography.Text>
          <InputNumber
            min={MIN_TRUCK_CAPACITY}
            max={MAX_TRUCK_CAPACITY}
            step={1}
            value={capacityValue}
            onChange={(value) => setCapacityDraft(typeof value === 'number' ? value : null)}
            addonAfter="箱位"
            style={{ width: 150 }}
          />
          <Button type="primary" ghost disabled={!capacityDirty || mutating} onClick={() => void handleApplyCapacity()}>
            应用并重排
          </Button>
          <Tooltip title="只封第一辆待装车；必须按车次顺序封车">
            <Button type="primary" icon={<LockOutlined />} disabled={!hasWaiting} loading={mutating} onClick={() => void handleSeal()}>
              封第一辆待装车
            </Button>
          </Tooltip>
          <Tooltip title="只能逆序解开最后一辆已封车">
            <Button icon={<UnlockOutlined />} disabled={!hasSealed || mutating} onClick={() => void handleUnseal()}>
              解封最后一辆
            </Button>
          </Tooltip>
          <Popconfirm
            title="清空全部封车记录？"
            description="已封车快照将全部解除，所有场次回到未封车排队状态（容量设置保留）。"
            okText="清空"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handleReset()}
          >
            <Button danger icon={<ClearOutlined />} disabled={!hasSealed || mutating}>
              清空封车记录
            </Button>
          </Popconfirm>
        </Space>
      </div>

      {view.delayedSceneIds.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${view.delayedSceneIds.length} 个场次因前车容量不足排队顺延`}
          description="顺延车次与受影响场次已在各车批卡片右上角标注；装车师傅按车批顺序依次发运即可。"
        />
      ) : null}

      {view.batches.length === 0 ? (
        <div className="gb-panel">
          {scenes.length === 0 ? (
            <EmptyState
              title="这出戏还没有场次"
              description="先到场次拆分页建档并登记角色影件，再回来生成装车单。"
              actionText="去拆场次"
              onAction={() => navigate(ROUTES.scenes(playId))}
            />
          ) : (
            <Empty description="没有需要装车的影件，请检查角色是否勾选头茬/身段/兵器" />
          )}
        </div>
      ) : (
        <Row gutter={[16, 16]}>
          {view.batches.map((batch) => (
            <Col key={batch.batchNo} xs={24} lg={12} xl={8}>
              <BatchCard
                batch={batch}
                canSeal={batch.status === 'waiting' && batch.batchNo === view.sealedCount + 1}
                canUnseal={batch.status === 'sealed' && batch.batchNo === view.sealedCount}
                mutating={mutating}
                onSeal={() => void handleSeal()}
                onUnseal={() => void handleUnseal()}
              />
            </Col>
          ))}
        </Row>
      )}
    </Space>
  );
}

interface BatchCardProps {
  batch: PackedBatch;
  canSeal: boolean;
  canUnseal: boolean;
  mutating: boolean;
  onSeal: () => void;
  onUnseal: () => void;
}

function BatchCard({ batch, canSeal, canUnseal, mutating, onSeal, onUnseal }: BatchCardProps) {
  const sealed = batch.status === 'sealed';
  const percent = Math.min(100, Math.round((batch.totalSlots / Math.max(1, batch.capacity)) * 100));
  const overload = batch.hasOverload;

  return (
    <Card
      size="small"
      style={{
        height: '100%',
        background: sealed ? '#f3ede0' : '#fffdf8',
        borderColor: sealed ? '#c9963c' : overload ? '#cf1322' : undefined,
      }}
      title={
        <Space size={8} wrap>
          <Typography.Text strong>第 {batch.batchNo} 车</Typography.Text>
          {sealed ? (
            <Tag color="gold" icon={<LockOutlined />}>
              已封车
            </Tag>
          ) : (
            <Tag color="blue">待装车</Tag>
          )}
          {batch.delayed ? (
            <Tooltip
              title={`受影响场次：${batch.units.map((unit) => `第${unit.seq}场 ${unit.title}`).join('；')}`}
            >
              <Tag color="orange">顺延 · 影响 {batch.affectedSceneIds.length} 场</Tag>
            </Tooltip>
          ) : null}
          {overload ? <Tag color="red">单车超载</Tag> : null}
        </Space>
      }
      extra={
        sealed ? (
          <Tooltip title={batch.sealedAt ? `封车于 ${formatStamp(batch.sealedAt)}` : ''}>
            <Tag>{batch.sealedAt ? formatStamp(batch.sealedAt) : '已封车'}</Tag>
          </Tooltip>
        ) : canSeal ? (
          <Button size="small" type="primary" loading={mutating} onClick={onSeal}>
            封本车
          </Button>
        ) : (
          <Tag>排队中</Tag>
        )
      }
      actions={
        sealed && canUnseal
          ? [
              <Button key="unseal" type="link" size="small" icon={<UnlockOutlined />} loading={mutating} onClick={onUnseal}>
                解封本车（最后一批）
              </Button>,
            ]
          : undefined
      }
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <div>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              装载率（{batch.totalSlots} / {batch.capacity} 箱位）
            </Typography.Text>
            <Typography.Text type={overload ? 'danger' : 'secondary'} strong style={{ fontSize: 12 }}>
              {percent}%
            </Typography.Text>
          </Space>
          <Progress
            percent={percent}
            showInfo={false}
            strokeColor={overload ? '#cf1322' : percent > 92 ? '#d48806' : '#7a1f1f'}
            size="small"
          />
        </div>

        {sealed ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            封车快照 · 场次或影件改动不影响本车
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            未封车 · 场次/角色/影件或容量改动后自动重排
          </Typography.Text>
        )}

        {batch.units.map((unit) => (
          <UnitBlock key={unit.sceneId} unit={unit} capacity={batch.capacity} />
        ))}
      </Space>
    </Card>
  );
}

function UnitBlock({ unit, capacity }: { unit: LoadUnit; capacity: number }) {
  const propItems = unit.items.filter((item) => item.kind !== 'screen');
  const overloaded = unit.totalSlots > capacity;
  return (
    <div
      style={{
        border: `1px dashed ${overloaded ? 'rgba(207,19,34,0.55)' : 'rgba(122,31,31,0.24)'}`,
        borderRadius: 8,
        padding: '8px 10px',
        background: unit.missing ? 'rgba(0,0,0,0.04)' : 'transparent',
        opacity: unit.missing ? 0.72 : 1,
      }}
    >
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap size={4}>
        <Space size={6} wrap>
          <Typography.Text strong style={{ fontSize: 13 }}>
            第 {unit.seq} 场 · {unit.title}
          </Typography.Text>
          {unit.missing ? <Tag color="default">场次已删除 · 快照保留</Tag> : null}
          {overloaded ? <Tag color="red">单场 {unit.totalSlots} 箱位 ＞ 全车 {capacity}</Tag> : null}
        </Space>
        <Tag>{unit.totalSlots} 箱位</Tag>
      </Space>
      <div style={{ marginTop: 6 }}>
        <Space size={4} wrap>
          <Tag color="purple">影窗 · {SHADOW_SCREEN_LABEL[unit.screen]}（{unit.screenItem.slots}）</Tag>
          {propItems.map((item) => (
            <PropTag key={item.id} item={item} />
          ))}
          {propItems.length === 0 ? <Typography.Text type="secondary">无角色影件</Typography.Text> : null}
        </Space>
      </div>
    </div>
  );
}

function PropTag({ item }: { item: LoadItem }) {
  return (
    <Tag style={{ marginInlineEnd: 0 }}>
      {item.label}（{item.slots}）
    </Tag>
  );
}
