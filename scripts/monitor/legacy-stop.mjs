// The Stop hook was removed in v2, but the log keeps the lines it wrote and the monitor still draws them. This is the bar those lines were
// judged against (the hook's default violation threshold), so an old audit still shows where it stood.
export const LEGACY_STOP_THRESHOLD = 0.9;
