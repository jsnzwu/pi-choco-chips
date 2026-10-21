import { Loader } from "@earendil-works/pi-tui";

const active = new Set();
class ToolPulse extends Loader {
  mark() { return this.getRenderedIndicator(); }
}

export function toolMark(context, frames = ["○", "●"]) {
  const state = context.state;
  let pulse = state["pcc:pulse"];
  const running = context.isPartial && context.executionStarted && !context.isError;
  if (running && !pulse) {
    // Loader starts in its constructor; defer redraw wiring until state is assigned.
    const ui = { requestRender() {} };
    pulse = new ToolPulse(ui, (text) => text, (text) => text, "", {
      frames, intervalMs: 500,
    });
    state["pcc:pulse"] = pulse;
    active.add(pulse);
    ui.requestRender = context.invalidate;
  } else if (!running && pulse) {
    pulse.stop();
    active.delete(pulse);
    delete state["pcc:pulse"];
  }
  return context.isError ? "✗" : context.isPartial ? pulse?.mark() ?? "·" : "✓";
}

export function stopToolPulses() {
  for (const pulse of active) pulse.stop();
  active.clear();
}
