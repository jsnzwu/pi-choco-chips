import { Box, Container, TruncatedText } from "@earendil-works/pi-tui";
import { toolMark } from "./tool-status.ts";

export const BASH_ROW = Symbol.for("pi-choco-chips.bash-row");
const PATCH = Symbol.for("pi-choco-chips.bash-groups");
const rowInfo = (component) => component.rendererState?.[BASH_ROW];

function groupedChildren(children, width) {
  // cutail: rendererState is a Pi 1.3 TUI capability; unknown row layouts remain ungrouped.
  if (!children.some(rowInfo)) return;
  const output = [];
  let changed = false;
  for (let index = 0; index < children.length;) {
    const first = children[index];
    if (!rowInfo(first)) { output.push(first); index++; continue; }
    const commands = [first];
    let end = index + 1;
    while (end < children.length) {
      const next = children[end];
      if (rowInfo(next)) commands.push(next);
      else if (next.render(width).length !== 0) break;
      end++;
    }
    if (commands.length < 2) output.push(...children.slice(index, end));
    else {
      changed = true;
      const info = commands.map(rowInfo);
      const pending = info.some((item) => item.context.isPartial);
      const failed = info.some((item) => item.context.isError);
      const theme = info[0].theme;
      const running = info.find((item) => item.context.isPartial && item.context.executionStarted && !item.context.isError);
      const color = failed ? "error" : running ? "accent" : pending ? "muted" : "success";
      const mark = pending ? running ? toolMark(running.context) : "·" : failed ? "✗" : "✓";
      const marker = !failed && running?.colorize ? running.colorize(mark) : theme.fg(color, mark);
      output.push(new TruncatedText(
        `${marker} ${theme.fg("toolTitle", theme.bold(`${pending ? "Running" : "Ran"} ${commands.length} shell commands`))}`,
        0, 0,
      ));
      const body = new Box(width >= 8 ? 2 : 0, 0);
      for (const command of commands) body.addChild({
        render(innerWidth) {
          const lines = command.render(innerWidth);
          return lines[0] === "" ? lines.slice(1) : lines;
        },
        invalidate: () => command.invalidate(),
        // Self-rendered tool rows reserve a leading spacer even when PCC hides it.
        handleMouse: (event) => command.handleMouse({ ...event, y: event.y + 1, height: event.height + 1 }),
      });
      output.push(body);
    }
    index = end;
  }
  return changed ? output : undefined;
}

export function installBashGroups() {
  const prototype = Container.prototype;
  if (prototype[PATCH]) { prototype[PATCH].group = groupedChildren; return; }
  const state = { group: groupedChildren, render: prototype.render };
  prototype[PATCH] = state;
  prototype.render = function(width) {
    const children = state.group(this.children, width);
    if (!children) return state.render.call(this, width);
    const view = new Container();
    view.children = children;
    const lines = state.render.call(view, width);
    this.mouseLayout = view.mouseLayout;
    return lines;
  };
}
