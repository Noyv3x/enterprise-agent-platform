/* <UsageTable/> — a generic responsive Ant table (legacy renderUsageTable,
   legacy-app.js:1755-1765). Its labelled wrapper keeps wide analytics data in
   its own scroll region while Ant owns column semantics and empty state. */

import { Table, type TableProps } from "antd";
import { Children, Fragment, isValidElement, type ReactNode } from "react";
import type { IconName } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { AdminCard } from "../AdminCard";

export interface UsageTableProps<T> {
  title: string;
  desc: string;
  icon: IconName;
  headers: string[];
  rows: T[];
  /** Returns the cell elements for one row (their count must match `headers`). */
  renderRow: (row: T) => ReactNode;
  emptyText: string;
}

function flattenCells(node: ReactNode): ReactNode[] {
  const cells: ReactNode[] = [];
  Children.forEach(node, (child) => {
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      cells.push(...flattenCells(child.props.children));
    } else {
      cells.push(child);
    }
  });
  return cells;
}

interface UsageTableRecord {
  key: number;
  cells: ReactNode[];
}

export function UsageTable<T>({
  title,
  desc,
  icon,
  headers,
  rows,
  renderRow,
  emptyText,
}: UsageTableProps<T>) {
  const dataSource: UsageTableRecord[] = rows.map((row, index) => ({
    key: index,
    cells: flattenCells(renderRow(row)),
  }));
  const columns: TableProps<UsageTableRecord>["columns"] = headers.map((header, index) => ({
    title: header,
    key: `${header}-${index}`,
    render: (_, record) => record.cells[index] ?? null,
  }));

  return (
    <AdminCard className="usage-card">
      <CardHead title={title} icon={icon} desc={desc} />
      <div className="usage-table-wrap" role="region" aria-label={title} tabIndex={0}>
        <Table<UsageTableRecord>
          className="eap-admin-usage-table"
          aria-label={title}
          columns={columns}
          dataSource={dataSource}
          pagination={false}
          size="middle"
          scroll={{ x: "max-content" }}
          locale={{ emptyText: <span className="muted">{emptyText}</span> }}
        />
      </div>
    </AdminCard>
  );
}
