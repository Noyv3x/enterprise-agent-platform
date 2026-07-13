/* <UsageTable/> — a generic responsive native table (legacy renderUsageTable,
   legacy-app.js:1755-1765). Its wrapper scrolls horizontally on small screens;
   native th/td semantics keep headers associated with cells for assistive tech. */

import { Children, Fragment, isValidElement, type ReactNode } from "react";
import type { IconName } from "../../../types";
import { CardHead } from "../../common/CardHead";

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

export function UsageTable<T>({
  title,
  desc,
  icon,
  headers,
  rows,
  renderRow,
  emptyText,
}: UsageTableProps<T>) {
  return (
    <section className="card usage-card">
      <CardHead title={title} icon={icon} desc={desc} />
      {rows.length ? (
        <div className="usage-table-wrap" role="region" aria-label={title} tabIndex={0}>
          <table className="usage-table" aria-label={title}>
            <thead>
              <tr className="usage-table__row usage-table__head">
                {headers.map((header, index) => (
                  <th scope="col" key={`${header}-${index}`}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr className="usage-table__row" key={index}>
                  {flattenCells(renderRow(row)).map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="muted">{emptyText}</div>
      )}
    </section>
  );
}
