import type { Demo } from "../lib/demo";

// Rendered inside a dropdown from the header. Two team blocks, tabular stats.
export function Scoreboard({ demo }: { demo: Demo }) {
  const rows = demo.players;
  const teamA = rows.filter((p) => p.team_label === "A");
  const teamB = rows.filter((p) => p.team_label === "B");

  const Block = ({ title, color, players }: { title: string; color: string; players: typeof rows }) => (
    <div>
      <div className={`mb-1 flex items-center gap-2 px-1 text-xs ${color}`}>
        <span>●</span>
        <span className="display uppercase tracking-wide">{title}</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase text-muted">
            <th className="text-left font-normal">player</th>
            <th className="num text-right font-normal">K</th>
            <th className="num text-right font-normal">D</th>
            <th className="num text-right font-normal">A</th>
            <th className="num text-right font-normal">ADR</th>
          </tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.steamid} className="border-t border-grid/40">
              <td className="max-w-[9rem] truncate py-1 text-ink">{p.name}</td>
              <td className="num text-right">{p.kills}</td>
              <td className="num text-right text-muted">{p.deaths}</td>
              <td className="num text-right text-muted">{p.assists}</td>
              <td className="num text-right">{p.adr}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="w-80 space-y-3 rounded-xl border border-grid bg-surface p-3 shadow-2xl">
      <Block title={`Team A · started T`} color="text-t" players={teamA} />
      <Block title={`Team B · started CT`} color="text-ct" players={teamB} />
    </div>
  );
}
