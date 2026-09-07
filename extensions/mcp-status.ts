import { stripVTControlCharacters } from "node:util";

// pi-mcp-adapter's versioned, read-only event contract; no package dependency.
export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

export function subscribeMcpServerNames(events, onChange) {
  let names = [];
  const unsubscribe = events.on(MCP_STATUS_EVENT, (snapshot) => {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.servers)) return;
    if (!snapshot.servers.every((server) => typeof server?.name === "string")) return;
    const next = snapshot.servers.map((server) => {
      const name = stripVTControlCharacters(server.name).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
      return name && (server.disabled ? `${name} (disabled)` : name);
    }).filter(Boolean);
    if (JSON.stringify(next) === JSON.stringify(names)) return;
    names = next;
    onChange(names);
  });
  return () => {
    unsubscribe();
    names = [];
  };
}
