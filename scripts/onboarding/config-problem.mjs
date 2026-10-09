// How a configuration error is told to a person: which file, what is wrong, and that they fix it and run the command again.

/** The config error as a person reads it: which file, what is wrong. */
export function configProblem(e, ui) {
  const m = /^(\/[^:]+\.json): (.*)$/s.exec(e.message);
  return m ? `${ui.path(m[1])} is invalid: ${m[2]}. Fix it, then run this again.` : `Recall's settings are invalid: ${e.message}. Fix it, then run this again.`;
}
