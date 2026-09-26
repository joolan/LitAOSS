import { useMemo, useState } from 'react';
import { read, utils, type WorkBook } from 'xlsx';
import type { PreviewRenderProps } from '../types';

const MAX_ROWS = 10000;
const MAX_COLS = 100;

function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

interface ParsedWorkbook {
  wb: WorkBook | null;
  error: string;
}

function parseWorkbook(data: ArrayBuffer): ParsedWorkbook {
  try {
    const wb = read(new Uint8Array(data), { type: 'array' });
    if (wb.SheetNames.length === 0) {
      return { wb: null, error: '工作簿中没有工作表' };
    }
    return { wb, error: '' };
  } catch (err) {
    return {
      wb: null,
      error: '表格解析失败: ' + (err instanceof Error ? err.message : String(err)),
    };
  }
}

export default function XlsxViewer({ data }: PreviewRenderProps) {
  const { wb, error } = useMemo(() => parseWorkbook(data), [data]);
  const [sheetIdx, setSheetIdx] = useState(0);

  const rows = useMemo(() => {
    if (!wb) return [];
    const sheetName = wb.SheetNames[Math.min(sheetIdx, wb.SheetNames.length - 1)];
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return [];
    return utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
  }, [wb, sheetIdx]);

  if (error) {
    return <div className="flex items-center justify-center h-64 text-red-400 text-sm">{error}</div>;
  }
  if (!wb) return null;

  const truncated = rows.length > MAX_ROWS;
  const visibleRows = truncated ? rows.slice(0, MAX_ROWS) : rows;
  const headerRow = visibleRows[0];
  const bodyRows = visibleRows.slice(1);
  const colCount = Math.min(
    MAX_COLS,
    Math.max(...visibleRows.map((r) => r.length), 1),
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      {wb.SheetNames.length > 1 && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-800 bg-gray-900 overflow-x-auto sticky top-0 z-10">
          {wb.SheetNames.map((name, i) => (
            <button
              key={name}
              onClick={() => setSheetIdx(i)}
              className={`px-2.5 py-1 rounded text-xs whitespace-nowrap transition-colors ${
                i === sheetIdx
                  ? 'bg-emerald-600 text-white'
                  : 'text-gray-400 hover:bg-gray-700'
              }`}
              title={name}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {visibleRows.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
            空工作表
          </div>
        ) : (
          <table className="border-collapse text-xs w-max min-w-full">
            <thead>
              <tr>
                <th className="sticky top-0 z-10 bg-gray-800 border border-gray-700 px-2 py-1.5 w-10 text-gray-500 font-normal">
                  #
                </th>
                {Array.from({ length: colCount }, (_, c) => (
                  <th
                    key={c}
                    className="sticky top-0 z-10 bg-gray-800 border border-gray-700 px-2 py-1.5 text-gray-400 font-medium whitespace-nowrap"
                  >
                    {columnName(c)}
                  </th>
                ))}
              </tr>
              <tr>
                <th className="sticky top-7 z-10 bg-gray-800 border border-gray-700 px-2 py-1.5 text-gray-500 font-normal">
                  1
                </th>
                {Array.from({ length: colCount }, (_, c) => (
                  <th
                    key={c}
                    className="sticky top-7 z-10 bg-gray-800 border border-gray-700 px-2 py-1.5 text-left text-white font-semibold whitespace-nowrap"
                  >
                    {headerRow?.[c] != null ? String(headerRow[c]) : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, r) => (
                <tr key={r} className={r % 2 === 1 ? 'bg-gray-900/50' : ''}>
                  <td className="border border-gray-800 px-2 py-1.5 text-gray-500 bg-gray-900/80">
                    {r + 2}
                  </td>
                  {Array.from({ length: colCount }, (_, c) => (
                    <td
                      key={c}
                      className="border border-gray-800 px-2 py-1.5 text-gray-300 whitespace-nowrap max-w-72 truncate"
                      title={row[c] != null ? String(row[c]) : ''}
                    >
                      {row[c] != null ? String(row[c]) : ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {truncated && (
          <div className="px-3 py-2 text-xs text-amber-400/90 bg-amber-500/10 border-t border-amber-500/20">
            表格过大，仅显示前 {MAX_ROWS} 行，请下载后查看完整内容
          </div>
        )}
      </div>
    </div>
  );
}
