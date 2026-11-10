/* ============================================================
   KANBO — /admin › Adoption by workspace (0058). Per workspace, for
   platform admins (admin_workspace_adoption checks is_admin()): people
   active in the last 7 days out of everyone who's joined, invites
   still waiting, tasks done this week, the last day anyone worked
   there, and a handover still waiting for its owner. A bar shows the
   share active at a glance; the quietest businesses are easy to spot.
   Active means worked there this week (a task, a comment, an update);
   the admin who provisioned a business isn't one of its people, and a
   business still waiting for its owner reads "Not started", last.
   Numbers only, never who did what or when in the day. Before 0058:
   "isn't switched on yet".
   ============================================================ */
import { useCallback, useEffect, useId, useState } from "react";
import { Button, Icon } from "../primitives";
import { KANBO_TODAY } from "../../data/data";
import { workspaceAdoption, type AdoptionRow } from "../../lib/rolloutApi";
import { lastActiveWords } from "../../lib/rollout";
import { findPack } from "../../packs";
import "./provision.css";

const pad = (n: number) => String(n).padStart(2, "0");
const isoToday = () => { const d = new Date(KANBO_TODAY); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export function AdoptionPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [rows, setRows] = useState<AdoptionRow[] | "off" | "failed" | null>(null);
  const [sort, setSort] = useState<"quiet" | "active">("quiet");
  const load = useCallback(() => { workspaceAdoption().then(setRows, () => setRows("failed")); }, []);
  useEffect(load, [load, refreshKey]);
  const today = isoToday();
  const share = (r: AdoptionRow) => (r.members ? r.weeklyActive / r.members : 0);
  // (a business still waiting for its owner hasn't started: it isn't quiet or busy yet, so it goes last)
  const waiting = (r: AdoptionRow) => !!r.handover && !r.handover.done;
  const list = Array.isArray(rows)
    ? [...rows].sort((a, b) => Number(waiting(a)) - Number(waiting(b)) || (sort === "quiet" ? share(a) - share(b) : share(b) - share(a)) || a.name.localeCompare(b.name))
    : [];
  const started = list.filter((r) => !waiting(r));
  const total = started.reduce((n, r) => n + r.weeklyActive, 0);
  const people = started.reduce((n, r) => n + r.members, 0);
  return (
    <section className="kadp" aria-labelledby={`kadp-${uid}`}>
      <div className="kadp-head">
        <Icon name="pulse" size={16} />
        <h2 id={`kadp-${uid}`} className="kadp-title">Adoption by workspace</h2>
        {Array.isArray(rows) && <span className="kadp-sum">{total} of {people} people active this week</span>}
        <span className="kadp-sort">
          <Button size="sm" variant={sort === "quiet" ? "secondary" : "ghost"} aria-pressed={sort === "quiet"} onClick={() => setSort("quiet")}>Quietest first</Button>
          <Button size="sm" variant={sort === "active" ? "secondary" : "ghost"} aria-pressed={sort === "active"} onClick={() => setSort("active")}>Most active</Button>
        </span>
      </div>
      {rows === null ? <p className="kadp-note">Loading…</p>
        : rows === "off" ? <p className="kadp-note">Not switched on yet: run migration 0058.</p>
        : rows === "failed" ? <p className="kadp-note">Couldn't load the numbers. <button type="button" className="kadp-retry" onClick={load}>Try again</button></p>
        : list.length === 0 ? <p className="kadp-note">No workspaces yet.</p> : (
          <table className="kadp-table">
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Active this week</th>
                <th scope="col" className="kadp-num">Invited</th>
                <th scope="col" className="kadp-num">Done this week</th>
                <th scope="col">Last worked in</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const pct = Math.round(share(r) * 100);
                return (
                  <tr key={r.id}>
                    <th scope="row">
                      <span className="kadp-name">{r.name}</span>
                      {(r.handover || r.pack) && (
                        <span className="kadp-meta">
                          {r.pack && <span>{findPack(r.pack)?.name ?? r.pack}</span>}
                          {r.handover && <span>{r.handover.done ? `Handed to ${r.handover.email}` : `Waiting for ${r.handover.email} to join`}</span>}
                        </span>
                      )}
                    </th>
                    <td>
                      {waiting(r) ? <span className="kadp-wait">Not started</span> : (
                        <span className="kadp-active">
                          <span className="kadp-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} data-low={pct < 50 || undefined} /></span>
                          <span className="kadp-count">{r.weeklyActive} of {r.members}</span>
                        </span>
                      )}
                    </td>
                    <td className="kadp-num">{r.invited || "—"}</td>
                    <td className="kadp-num">{r.doneWeek || "—"}</td>
                    <td className="kadp-last">{r.lastDay ? lastActiveWords(r.lastDay, today) : "Not yet"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      {Array.isArray(rows) && list.length > 0 && <p className="kadp-note">Active: changed a task, commented or posted an update there this week. Whoever provisioned a business isn't counted in it.</p>}
    </section>
  );
}
