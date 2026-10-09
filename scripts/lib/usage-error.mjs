// A command line that cannot be run as written (an unknown option, a missing or bad value): the CLI prints one line and exits 2.
export class UsageError extends Error {
  constructor(message) { super(message); this.name = "UsageError"; }
}
