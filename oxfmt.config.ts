import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

// Ultracite's formatter preset. Code stays at 100 columns, as the kit was written; prose keeps its own line breaks,
// so a paragraph's diff shows only the words that changed.
// The README's samples are laid out for reading: a state table keeps one state per line.
export default defineConfig({
  ...ultracite,
  printWidth: 100,
  proseWrap: "preserve",
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), "README.md"],
});
