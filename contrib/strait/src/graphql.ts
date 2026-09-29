// GraphQL read policy for POST https://api.github.com/graphql.
//
// A document is allowed only if every operation is a query and every field it
// selects lies on a path in GITHUB_FIELDS, rooted at `repository(owner, name)`
// for a repository in githubRepos. Anything else, including a document this
// module cannot analyse, is left for review. The rules are a trimmed copy of
// nas's (src/network/authz/graphql.ts and
// docs/superpowers/specs/2026-09-20-graphql-field-path-policy-design.md):
//
// - Paths are real field names: aliases are dropped, named and inline
//   fragments are expanded where they are used, and type conditions are not
//   path elements, so every branch is checked.
// - A leaf must be listed exactly. A field with children must be a proper
//   prefix of a listed path; `/repository` alone grants nothing below it.
// - `@skip` and `@include` do not exempt a selection. Any other directive,
//   a duplicate argument, variable or fragment, an undefined or cyclic
//   fragment, or a document over the budget makes the document unanalysable.
// - owner and name must both be present on each `repository` occurrence and
//   resolve to strings that name an allowed repository together.

import {
  type DocumentNode,
  type FragmentDefinitionNode,
  Kind,
  type OperationDefinitionNode,
  parse,
  type SelectionNode,
  type SelectionSetNode,
  type ValueNode,
} from "graphql";

/**
 * Paths gh needs for common reads, written as a selection set. Taken from the
 * queries gh 2.46 sends for `pr view`/`list`/`checks`, `issue view`/`list`,
 * `release view`/`list` and `repo view` (src/testdata/gh_queries.json). Every
 * leaf is a scalar, and nothing here leads to another repository's content:
 * reaching one needs a field such as `owner { repositories }` or
 * `author { ... on User { pullRequests } }`, none of which is listed.
 */
const GITHUB_FIELDS = `{
  repository {
    name description hasIssuesEnabled
    owner { id login }
    issues { nodes { ...issueSummary } pageInfo { ...page } totalCount }
    issueOrPullRequest { __typename ...conversation stateReason }
    pullRequests {
      nodes {
        number title state url createdAt isDraft isCrossRepository headRefName
        headRepositoryOwner { id login name }
      }
      pageInfo { ...page } totalCount
    }
    pullRequest {
      ...conversation
      additions deletions baseRefName headRefName isCrossRepository isDraft
      maintainerCanModify mergeable
      headRepository { id name }
      headRepositoryOwner { id login name }
      autoMergeRequest {
        authorEmail commitBody commitHeadline enabledAt mergeMethod
        enabledBy { id login name }
      }
      reviewRequests {
        nodes {
          requestedReviewer { __typename login name slug organization { login } }
        }
      }
      reviews {
        nodes {
          id body state submittedAt authorAssociation
          author { login } commit { oid } reactionGroups { ...reactions }
        }
        pageInfo { ...page } totalCount
      }
      commits {
        totalCount
        nodes {
          commit {
            statusCheckRollup {
              contexts {
                nodes {
                  __typename context state targetUrl createdAt description
                  name status conclusion startedAt completedAt detailsUrl
                  checkSuite { workflowRun { workflow { name } } }
                }
                pageInfo { ...page }
              }
            }
          }
        }
      }
    }
    release { databaseId isDraft }
    releases {
      nodes { name tagName isDraft isLatest isPrerelease createdAt publishedAt }
      pageInfo { ...page }
    }
  }
}
fragment page on PageInfo { endCursor hasNextPage }
fragment reactions on ReactionGroup { content users { totalCount } }
fragment issueSummary on Issue {
  number title state stateReason url updatedAt
  labels { nodes { id name description color } totalCount }
}
fragment conversation on Issue {
  id number title state url body createdAt
  author { id login name }
  assignees { nodes { id login name } totalCount }
  labels { nodes { id name description color } totalCount }
  milestone { number title description dueOn }
  projectCards { nodes { project { name } column { name } } totalCount }
  reactionGroups { ...reactions }
  comments {
    nodes {
      id body url createdAt authorAssociation includesCreatedEdit
      isMinimized minimizedReason viewerDidAuthor
      author { id login name } reactionGroups { ...reactions }
    }
    pageInfo { ...page } totalCount
  }
}`;

/** The root field every allowed path starts at, and its owner/name arguments. */
const REPOSITORY_PATH = "/repository";

/** Caps on work per document; exceeding one makes it unanalysable. */
const LIMITS = { maxTokens: 20_000, maxDepth: 32, maxNodes: 20_000 };

export type GraphqlVerdict =
  | { ok: true }
  | { ok: false; reason: string; unanalysable?: boolean };

interface Occurrence {
  path: string;
  leaf: boolean;
  /** Arguments that resolved to strings. */
  args: Map<string, string>;
}

const allowed = allowedPaths(GITHUB_FIELDS);

/** The leaves of GITHUB_FIELDS, for tests that tie them to gh's queries. */
export const GITHUB_LEAF_PATHS: ReadonlySet<string> = allowed.leaves;

/** The leaf paths a document selects, or null when it cannot be analysed. */
export function leafPaths(query: string): string[] | null {
  const facts = analyse(query, undefined);
  if (facts === null) return null;
  return facts.fields.filter((o) => o.leaf).map((o) => o.path);
}

/**
 * Judge a parsed JSON request body. `isRepoAllowed` decides whether one
 * `repository(owner, name)` occurrence names an allowed repository.
 */
export function judgeGraphql(
  body: unknown,
  isRepoAllowed: (owner: string, name: string) => boolean,
): GraphqlVerdict {
  const bad = (reason: string): GraphqlVerdict => ({
    ok: false,
    reason,
    unanalysable: true,
  });
  // A batch (array) or extra members would be executed or read in ways this
  // check does not model.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return bad("GraphQL body is not a single request object");
  }
  const request = body as Record<string, unknown>;
  for (const key of Object.keys(request)) {
    if (key !== "query" && key !== "variables" && key !== "operationName") {
      return bad(
        `GraphQL body has an unexpected member ${JSON.stringify(key)}`,
      );
    }
  }
  if (typeof request.query !== "string") {
    return bad("GraphQL body has no query string");
  }
  const variables = request.variables;
  if (
    variables !== undefined &&
    variables !== null &&
    (typeof variables !== "object" || Array.isArray(variables))
  ) {
    return bad("GraphQL variables are not an object");
  }

  const analysed = analyse(
    request.query,
    (variables ?? undefined) as Record<string, unknown> | undefined,
  );
  if (analysed === null) return bad("GraphQL document cannot be analysed");

  if (analysed.operations.some((op) => op !== "query")) {
    return { ok: false, reason: "only GraphQL queries are allowed" };
  }
  for (const o of analysed.fields) {
    const ok = o.leaf ? allowed.leaves.has(o.path) : allowed.inner.has(o.path);
    if (!ok) {
      return { ok: false, reason: `GraphQL field ${o.path} is not allowed` };
    }
    if (o.path === REPOSITORY_PATH) {
      const owner = o.args.get("owner");
      const name = o.args.get("name");
      if (owner === undefined || name === undefined) {
        return {
          ok: false,
          reason: "GraphQL repository needs owner and name strings",
        };
      }
      if (!isRepoAllowed(owner, name)) {
        return {
          ok: false,
          reason: `${owner}/${name} is not an allowed repository`,
        };
      }
    }
  }
  return { ok: true };
}

/** Leaves and the proper prefixes of the listed paths. */
function allowedPaths(source: string): {
  leaves: ReadonlySet<string>;
  inner: ReadonlySet<string>;
} {
  const facts = analyse(source, undefined);
  if (facts === null) throw new Error("GITHUB_FIELDS does not parse");
  const leaves = new Set<string>();
  const inner = new Set<string>();
  for (const o of facts.fields) (o.leaf ? leaves : inner).add(o.path);
  return { leaves, inner };
}

/**
 * Expand every operation into field occurrences, or return null when the
 * document cannot be judged. Fragments are expanded at each use with an
 * iterative stack, and every step is charged against `LIMITS.maxNodes` so a
 * small body cannot make the expansion (or the paths it builds) blow up.
 */
function analyse(
  text: string,
  variables: Record<string, unknown> | undefined,
): { operations: string[]; fields: Occurrence[] } | null {
  let document: DocumentNode;
  try {
    document = parse(text, { maxTokens: LIMITS.maxTokens, noLocation: true });
  } catch {
    return null;
  }

  const fragments = new Map<string, FragmentDefinitionNode>();
  const operations: OperationDefinitionNode[] = [];
  for (const d of document.definitions) {
    if (d.kind === Kind.OPERATION_DEFINITION) {
      const names = new Set<string>();
      for (const v of d.variableDefinitions ?? []) {
        if (names.has(v.variable.name.value)) return null;
        names.add(v.variable.name.value);
      }
      operations.push(d);
    } else if (d.kind === Kind.FRAGMENT_DEFINITION) {
      if (fragments.has(d.name.value)) return null;
      fragments.set(d.name.value, d);
    } else {
      // Schema definitions and extensions are not executable.
      return null;
    }
  }
  if (operations.length === 0) return null;

  interface Frame {
    selections: readonly SelectionNode[];
    index: number;
    path: string;
    depth: number;
    /** Fragments being expanded on this branch, to reject cycles. */
    active: ReadonlySet<string>;
    defaults: ReadonlyMap<string, ValueNode | undefined>;
  }
  const fields: Occurrence[] = [];
  let charged = 0;
  const charge = (n = 1) => {
    charged += n;
    return charged <= LIMITS.maxNodes;
  };
  const directivesOk = (node: {
    directives?: readonly { name: { value: string } }[];
  }) =>
    (node.directives ?? []).every(
      (d) =>
        charge() && (d.name.value === "skip" || d.name.value === "include"),
    );

  const stack: Frame[] = [];
  for (const op of [...operations].reverse()) {
    if (!directivesOk(op)) return null;
    if (!(op.variableDefinitions ?? []).every(directivesOk)) return null;
    const defaults = new Map<string, ValueNode | undefined>();
    for (const v of op.variableDefinitions ?? []) {
      defaults.set(v.variable.name.value, v.defaultValue);
    }
    stack.push(frame(op.selectionSet, "", 0, new Set(), defaults));
  }
  function frame(
    set: SelectionSetNode,
    path: string,
    depth: number,
    active: ReadonlySet<string>,
    defaults: ReadonlyMap<string, ValueNode | undefined>,
  ): Frame {
    return {
      selections: set.selections,
      index: 0,
      path,
      depth,
      active,
      defaults,
    };
  }

  while (stack.length > 0) {
    const top = stack[stack.length - 1] as Frame;
    if (top.index >= top.selections.length) {
      stack.pop();
      continue;
    }
    const s = top.selections[top.index++] as SelectionNode;
    if (!charge() || !directivesOk(s)) return null;

    if (s.kind === Kind.FIELD) {
      const depth = top.depth + 1;
      if (depth > LIMITS.maxDepth) return null;
      const path = `${top.path}/${s.name.value}`;
      // Names are one token however long, so charge for the path we keep.
      if (!charge(Math.floor(path.length / 64))) return null;
      const args = new Map<string, string>();
      const seen = new Set<string>();
      for (const a of s.arguments ?? []) {
        if (!charge() || seen.has(a.name.value)) return null;
        seen.add(a.name.value);
        const v = resolveString(a.value, variables, top.defaults);
        if (v !== undefined) args.set(a.name.value, v);
      }
      fields.push({ path, leaf: s.selectionSet === undefined, args });
      if (s.selectionSet) {
        stack.push(
          frame(s.selectionSet, path, depth, top.active, top.defaults),
        );
      }
    } else if (s.kind === Kind.INLINE_FRAGMENT) {
      stack.push(
        frame(s.selectionSet, top.path, top.depth, top.active, top.defaults),
      );
    } else {
      const name = s.name.value;
      const f = fragments.get(name);
      if (f === undefined || top.active.has(name)) return null;
      if (!directivesOk(f)) return null;
      const active = new Set(top.active).add(name);
      stack.push(
        frame(f.selectionSet, top.path, top.depth, active, top.defaults),
      );
    }
  }
  return { operations: operations.map((o) => o.operation), fields };
}

/**
 * A string literal, or a variable whose supplied value (or, when not
 * supplied, declared default) is a string. Anything else is unresolved.
 */
function resolveString(
  value: ValueNode,
  variables: Record<string, unknown> | undefined,
  defaults: ReadonlyMap<string, ValueNode | undefined>,
): string | undefined {
  if (value.kind === Kind.STRING) return value.value;
  if (value.kind !== Kind.VARIABLE) return undefined;
  const name = value.name.value;
  if (variables !== undefined && Object.hasOwn(variables, name)) {
    const v = variables[name];
    return typeof v === "string" ? v : undefined;
  }
  const d = defaults.get(name);
  return d?.kind === Kind.STRING ? d.value : undefined;
}
