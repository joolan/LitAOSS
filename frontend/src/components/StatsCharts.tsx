import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { AlertCircle } from 'lucide-react';
import { api, StatsSummary, LoginDayCount } from '../api/client';
import { decryptNameForStorage } from '../crypto/fileKey';

type Chart = ReturnType<typeof echarts.init>;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function typeLabel(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (!m || m === 'unknown') return '其他';
  if (m.startsWith('image/')) return '图片';
  if (m.startsWith('video/')) return '视频';
  if (m.startsWith('audio/')) return '音频';
  if (m === 'application/pdf') return 'PDF';
  if (m.startsWith('text/')) return '文本';
  if (m.includes('zip') || m.includes('rar') || m.includes('7z') || m.includes('tar') || m.includes('gzip') || m.includes('compress')) return '压缩包';
  if (m.includes('spreadsheet') || m.includes('excel') || m.includes('csv')) return '表格';
  if (m.includes('word') || m.includes('document')) return '文档';
  if (m.includes('presentation') || m.includes('powerpoint')) return '演示';
  if (m.includes('json') || m.includes('xml')) return '文本';
  return mime;
}

const PALETTE = ['#34d399', '#60a5fa', '#fbbf24', '#f472b6', '#a78bfa', '#f87171', '#2dd4bf', '#94a3b8'];

export default function StatsCharts() {
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [loginDays, setLoginDays] = useState<LoginDayCount[]>([]);
  const [dirNames, setDirNames] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const pieRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sum, logins] = await Promise.all([api.getStatsSummary(), api.getLoginStats()]);
        if (cancelled) return;
        const names: Record<string, string> = {};
        await Promise.all(
          sum.top_dirs.map(async (d) => {
            if (!d.id) {
              names[d.id] = '根目录（散文件）';
              return;
            }
            try {
              names[d.id] = (await decryptNameForStorage(d.name_encrypted)) || '（未命名）';
            } catch {
              names[d.id] = '（解密失败）';
            }
          }),
        );
        if (cancelled) return;
        setSummary(sum);
        setLoginDays(logins.days || []);
        setDirNames(names);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!summary || error) return;
    const charts: Chart[] = [];
    const instances = [pieRef.current, barRef.current, lineRef.current].map((el) => {
      if (!el) return null;
      const chart = echarts.init(el);
      charts.push(chart);
      return chart;
    });

    // 类型分布（按类别归并，按占用排序）
    const typeAgg = new Map<string, { count: number; size: number }>();
    for (const t of summary.types) {
      const label = typeLabel(t.file_type);
      const cur = typeAgg.get(label) || { count: 0, size: 0 };
      cur.count += t.count;
      cur.size += t.size;
      typeAgg.set(label, cur);
    }
    const typeEntries = [...typeAgg.entries()].sort((a, b) => b[1].size - a[1].size);
    instances[0]?.setOption({
      color: PALETTE,
      tooltip: {
        trigger: 'item',
        formatter: (params: any) => {
          const d = typeAgg.get(params.name) || { count: 0, size: 0 };
          return `${params.name}<br/>占用 ${formatBytes(d.size)} · ${d.count} 个`;
        },
      },
      legend: { bottom: 0, textStyle: { color: '#9ca3af', fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
      series: [{
        type: 'pie',
        radius: ['38%', '62%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#111827', borderWidth: 2 },
        label: { color: '#d1d5db', fontSize: 11, formatter: '{b}' },
        data: typeEntries.map(([name, d]) => ({ name, value: d.size })),
      }],
    });

    // 目录占用 Top 10（横向条形，数据倒序使最大在上）
    const dirMeta = [...summary.top_dirs].reverse();
    instances[1]?.setOption({
      color: ['#34d399'],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          const d = dirMeta[p.dataIndex];
          if (!d) return '';
          const name = d.id ? dirNames[d.id] || '…' : '根目录（散文件）';
          return `${name}<br/>占用 ${formatBytes(p.value)} · ${d.count} 个文件`;
        },
      },
      grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
      xAxis: {
        type: 'value',
        axisLabel: { color: '#6b7280', fontSize: 10, formatter: (v: any) => formatBytes(v) },
        splitLine: { lineStyle: { color: '#1f2937' } },
      },
      yAxis: {
        type: 'category',
        data: dirMeta.map((d) => (d.id ? dirNames[d.id] || '…' : '根目录（散文件）')),
        axisLabel: { color: '#d1d5db', fontSize: 11, width: 130, overflow: 'truncate' },
        axisLine: { lineStyle: { color: '#374151' } },
      },
      series: [{
        type: 'bar',
        data: dirMeta.map((d) => d.size),
        barMaxWidth: 18,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: {
          show: true,
          position: 'right',
          color: '#9ca3af',
          fontSize: 10,
          formatter: (p: any) => formatBytes(p.value),
        },
      }],
    });

    // 近 30 天成功登录（缺失日期补零成连续 30 天）
    const dayMap = new Map(loginDays.map((d) => [d.day, d.count]));
    const days: { label: string; count: number }[] = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const dt = new Date(now.getTime() - i * 86400000);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      days.push({ label: key.slice(5), count: dayMap.get(key) || 0 });
    }
    instances[2]?.setOption({
      color: ['#60a5fa'],
      tooltip: { trigger: 'axis' },
      grid: { left: 8, right: 8, top: 20, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        data: days.map((d) => d.label),
        axisLabel: { color: '#6b7280', fontSize: 9, interval: 2 },
        axisLine: { lineStyle: { color: '#374151' } },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { color: '#6b7280', fontSize: 10 },
        splitLine: { lineStyle: { color: '#1f2937' } },
      },
      series: [{
        type: 'bar',
        data: days.map((d) => d.count),
        barMaxWidth: 14,
        itemStyle: { borderRadius: [3, 3, 0, 0] },
      }],
    });

    const onResize = () => charts.forEach((c) => c.resize());
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      charts.forEach((c) => c.dispose());
    };
  }, [summary, loginDays, dirNames, error]);

  if (error) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
        <AlertCircle className="w-4 h-4 flex-shrink-0" />
        统计加载失败：{error}
      </div>
    );
  }
  if (!summary) {
    return <div className="text-gray-400 text-sm py-8 text-center">加载统计…</div>;
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: '文件数', value: summary.totals.file_count.toLocaleString() },
          { label: '文件夹数', value: summary.totals.folder_count.toLocaleString() },
          { label: '总占用', value: formatBytes(summary.totals.total_size) },
        ].map((c) => (
          <div key={c.label} className="rounded-lg bg-gray-800/60 border border-gray-700/60 p-4">
            <div className="text-xs text-gray-400">{c.label}</div>
            <div className="text-xl font-semibold text-white mt-1">{c.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-lg bg-gray-800/60 border border-gray-700/60 p-4">
          <div className="text-sm font-medium text-gray-300 mb-2">文件类型分布（按占用）</div>
          <div ref={pieRef} className="h-72" />
        </div>
        <div className="rounded-lg bg-gray-800/60 border border-gray-700/60 p-4">
          <div className="text-sm font-medium text-gray-300 mb-2">顶层目录占用 Top 10</div>
          <div ref={barRef} className="h-72" />
        </div>
      </div>

      <div className="rounded-lg bg-gray-800/60 border border-gray-700/60 p-4">
        <div className="text-sm font-medium text-gray-300 mb-2">近 30 天成功登录</div>
        <div ref={lineRef} className="h-56" />
      </div>
    </div>
  );
}
