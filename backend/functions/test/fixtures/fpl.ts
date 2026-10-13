/** Small hand-built FPL API payloads in the real response shape (fields we don't read are omitted). */
import type { BootstrapStatic, EventLive } from "../../src/fpl/parse";

export function bootstrap(opts: { deadlines: string[]; checked?: number[] }): BootstrapStatic {
  return {
    events: opts.deadlines.map((d, i) => ({
      id: i + 1, deadline_time: d, finished: (opts.checked || []).includes(i + 1),
      data_checked: (opts.checked || []).includes(i + 1), is_current: false,
    })),
    teams: [{ id: 1, short_name: "ARS" }, { id: 2, short_name: "LIV" }],
    elements: [
      { id: 10, code: 1001, web_name: "Raya", first_name: "David", second_name: "Raya", element_type: 1, team: 1, status: "a", news: "" },
      { id: 11, code: 1002, web_name: "Saliba", first_name: "William", second_name: "Saliba", element_type: 2, team: 1, status: "a", news: "" },
      { id: 12, code: 1003, web_name: "Saka", first_name: "Bukayo", second_name: "Saka", element_type: 3, team: 1, status: "d", news: "Knock" },
      { id: 20, code: 2001, web_name: "Salah", first_name: "Mohamed", second_name: "Salah", element_type: 3, team: 2, status: "a", news: "" },
      { id: 21, code: 2002, web_name: "Isak", first_name: "Alexander", second_name: "Isak", element_type: 4, team: 2, status: "a", news: "" },
      { id: 22, code: 2003, web_name: "Konaté", first_name: "Ibrahima", second_name: "Konaté", element_type: 2, team: 2, status: "a", news: "" },
      { id: 99, code: 9999, web_name: "Arteta", first_name: "Mikel", second_name: "Arteta", element_type: 5, team: 1, status: "a", news: "" },
    ],
  };
}

type Line = { id: number; min: number; g?: number; a?: number; cs?: number; yc?: number; fixtures?: number };
export function live(lines: Line[]): EventLive {
  return {
    elements: lines.map(l => ({
      id: l.id,
      stats: { minutes: l.min, goals_scored: l.g || 0, assists: l.a || 0, clean_sheets: l.cs || 0,
               own_goals: 0, yellow_cards: l.yc || 0, red_cards: 0 },
      explain: Array.from({ length: l.fixtures ?? (l.min ? 1 : 0) }, (_, i) => ({
        fixture: i + 1, stats: [{ identifier: "minutes", value: l.min }],
      })),
    })),
  };
}
