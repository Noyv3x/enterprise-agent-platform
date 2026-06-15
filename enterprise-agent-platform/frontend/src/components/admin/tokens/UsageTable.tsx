/* <UsageTable/> — a generic responsive usage table (legacy renderUsageTable,
   legacy-app.js:1755-1765). The `--usage-cols` CSS var drives the grid columns;
   rows scroll horizontally on small screens. Empty rows render the empty text. */

import type { ReactNode } from "react";
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
        <div
          className="usage-table"
          style={{ "--usage-cols": headers.length } as React.CSSProperties}
        >
          <div className="usage-table__row usage-table__head">
            {headers.map((header) => (
              <span key={header}>{header}</span>
            ))}
          </div>
          {rows.map((row, index) => (
            <div className="usage-table__row" key={index}>
              {renderRow(row)}
            </div>
          ))}
        </div>
      ) : (
        <div className="muted">{emptyText}</div>
      )}
    </section>
  );
}
