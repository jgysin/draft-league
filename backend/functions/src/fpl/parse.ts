/** Parsing for the public FPL API (fantasy.premierleague.com/api). Pure so it can be tested on fixtures. */
import { FplEvent, Player, PlayerGwStats, Position } from "../core/types";

const POS: Record<number, Position> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

export interface BootstrapStatic {
  events: { id: number; deadline_time: string; finished: boolean; data_checked: boolean; is_current: boolean }[];
  teams: { id: number; short_name: string }[];
  elements: {
    id: number; code: number; web_name: string; first_name: string; second_name: string;
    element_type: number; team: number; status: string; news: string;
  }[];
}

export function parseBootstrap(data: BootstrapStatic): { players: Player[]; events: FplEvent[]; elementToCode: Record<string, string> } {
  const teams: Record<number, string> = {};
  for (const t of data.teams) teams[t.id] = t.short_name;
  const players: Player[] = [];
  const elementToCode: Record<string, string> = {};
  for (const e of data.elements) {
    const position = POS[e.element_type];
    if (!position) continue;   // managers (element_type 5) and anything new
    const code = String(e.code);
    elementToCode[e.id] = code;
    players.push({
      code, fplId: e.id, name: e.web_name,
      fullName: `${e.first_name} ${e.second_name}`.trim(),
      position, club: teams[e.team] || "?", status: e.status || "a", news: e.news || "",
    });
  }
  const events = data.events.map(ev => ({
    id: ev.id, deadline: ev.deadline_time, finished: ev.finished,
    dataChecked: ev.data_checked, isCurrent: ev.is_current,
  }));
  return { players, events, elementToCode };
}

export interface EventLive {
  elements: {
    id: number;
    stats: { minutes: number; goals_scored: number; assists: number; clean_sheets: number;
             own_goals: number; yellow_cards: number; red_cards: number };
    explain: { fixture: number; stats: { identifier: string; value: number }[] }[];
  }[];
}

/** Gameweek stats keyed by player code. Players who did not feature are left out. */
export function parseLive(data: EventLive, elementToCode: Record<string, string>): Record<string, PlayerGwStats> {
  const out: Record<string, PlayerGwStats> = {};
  for (const e of data.elements) {
    const code = elementToCode[e.id];
    if (!code) continue;
    const s = e.stats;
    const apps = (e.explain || []).filter(f =>
      f.stats.some(x => x.identifier === "minutes" && x.value > 0)).length
      || (s.minutes > 0 ? 1 : 0);
    if (!apps && !s.minutes) continue;
    out[code] = {
      apps, minutes: s.minutes, goals: s.goals_scored, assists: s.assists, cs: s.clean_sheets,
      yc: s.yellow_cards, rc: s.red_cards, og: s.own_goals,
    };
  }
  return out;
}

/** Gameweeks that have started but whose stats FPL has not finalised yet. */
export function unsettledGameweeks(events: FplEvent[], now: Date): number[] {
  return events.filter(e => new Date(e.deadline) <= now && !e.dataChecked).map(e => e.id);
}

/** Gameweeks whose deadline has passed, newest last. */
export function passedDeadlines(events: FplEvent[], now: Date): number[] {
  return events.filter(e => new Date(e.deadline) <= now).map(e => e.id);
}
