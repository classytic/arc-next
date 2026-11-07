// TanStack Query rules over arc-next's src (Biome owns every other rule).
// `recommended-strict` adds `prefer-query-options`: build options with queryOptions/infiniteQueryOptions.
import pluginQuery from "@tanstack/eslint-plugin-query";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: ["src/**/*.ts"],
    // Directives for react-hooks rules belong to editors that run them; this lane does not.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: { parser: tsParser, ecmaVersion: "latest", sourceType: "module" },
    // react-hooks is registered (not enabled) so the source's react-hooks directives resolve.
    plugins: { "@tanstack/query": pluginQuery, "react-hooks": reactHooks },
    rules: {
      ...pluginQuery.configs["flat/recommended-strict"]
        .map((c) => c.rules)
        .reduce((all, rules) => Object.assign(all, rules), {}),
    },
  },
];
