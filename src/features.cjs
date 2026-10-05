'use strict'

// Feature switches for the parts of Prompt Optimizer that are kept in the codebase
// but deliberately not enabled yet.
//
// The project-context collector and the next-prompt predictor are archived, not
// deleted: their implementation stays in `core.cjs` / `index.cjs` and can be
// switched back on by flipping these flags. While they are off the plugin only
// runs `optimize` mode and never reads the workspace.
const FEATURES = Object.freeze({
  projectContext: false,
  prediction: false,
})

module.exports = { FEATURES }
