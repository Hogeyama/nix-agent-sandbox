// GraphQL read policy for POST https://api.github.com/graphql.
//
// A document is allowed only if every operation is a query and every field it
// selects lies on a path in GITHUB_FIELDS. Almost all of them are rooted at
// `repository(owner, name)`, which must name a repository in githubRepos. Anything else, including a document this
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
 * Paths gh needs for its reads of one repository, written as a selection set.
 * Taken from every query gh 2.46, 2.90 and 2.102 send for `pr view`/`list`/`checks`,
 * `issue view`/`list`/`status`, `release view`/`list`, `label list` and
 * `repo view`, with each command's `--json` asking for every field it offers
 * (src/core/testdata/gh_queries.json).
 *
 * Every leaf is a scalar, and nothing here leads to another repository's
 * content: reaching one needs a field such as `owner { repositories }`,
 * `viewer { starredRepositories }` or `author { ... on User { pullRequests } }`,
 * none of which is listed. Where a path does step into another repository or
 * project (`parent`, `templateRepository`, `closingIssuesReferences`,
 * `closedByPullRequestsReferences`, `projectItems`), it stops at IDs, names,
 * numbers and URLs; LINKED_ISSUE_TITLES is the one exception, and it is off
 * by default. Outside `repository` there are only gh's schema probes
 * (`__type`), which return field names, and `viewer { login }`.
 */
const GITHUB_FIELDS = `{
  __type { enumValues { name } fields { name } }
  repository {
    archivedAt createdAt deleteBranchOnMerge description diskUsage forkCount
    hasDiscussionsEnabled hasIssuesEnabled hasProjectsEnabled hasWikiEnabled
    homepageUrl id isArchived isBlankIssuesEnabled isEmpty isFork
    isInOrganization isMirror isPrivate isSecurityPolicyEnabled isTemplate
    isUserConfigurationRepository mergeCommitAllowed mirrorUrl name
    nameWithOwner openGraphImageUrl pushedAt rebaseMergeAllowed
    securityPolicyUrl squashMergeAllowed sshUrl stargazerCount updatedAt url
    usesCustomOpenGraphImage viewerCanAdminister viewerDefaultCommitEmail
    viewerDefaultMergeMethod viewerHasStarred viewerPermission
    viewerPossibleCommitEmails viewerSubscription visibility
    assignableUsers { nodes { id login name } }
    codeOfConduct { key name url }
    contactLinks { about name url }
    defaultBranchRef { name }
    fundingLinks { platform url }
    issueOrPullRequest {
      __typename body closed closedAt createdAt id isPinned number state
      stateReason title updatedAt url
      assignees { nodes { databaseId id login name } totalCount }
      author { id login name }
      blockedBy {
        totalCount
        nodes { id number repository { nameWithOwner } state url }
      }
      blocking {
        totalCount
        nodes { id number repository { nameWithOwner } state url }
      }
      closedByPullRequestsReferences {
        nodes { id number repository { id name owner { id login } } url }
        pageInfo { endCursor hasNextPage }
      }
      comments {
        totalCount
        nodes {
          authorAssociation body createdAt id includesCreatedEdit isMinimized
          minimizedReason url viewerDidAuthor
          author { id login name }
          reactionGroups { content users { totalCount } }
        }
        pageInfo { endCursor hasNextPage }
      }
      issueType { color description id name }
      labels { nodes { color description id name } totalCount }
      milestone { description dueOn number title }
      parent { id number repository { nameWithOwner } state url }
      projectCards { nodes { column { name } project { name } } totalCount }
      reactionGroups { content users { totalCount } }
      subIssues {
        totalCount
        nodes { id number repository { nameWithOwner } state url }
      }
      subIssuesSummary { completed percentCompleted total }
    }
    issueTemplates { about body name title }
    issues {
      totalCount
      nodes {
        body closed closedAt createdAt id isPinned number state stateReason
        title updatedAt url
        assignees { nodes { databaseId id login name } totalCount }
        author { id login name }
        blockedBy {
          totalCount
          nodes { id number repository { nameWithOwner } state url }
        }
        blocking {
          totalCount
          nodes { id number repository { nameWithOwner } state url }
        }
        closedByPullRequestsReferences {
          nodes { id number repository { id name owner { id login } } url }
          pageInfo { endCursor hasNextPage }
        }
        comments {
          totalCount
          nodes {
            authorAssociation body createdAt id includesCreatedEdit
            isMinimized minimizedReason url viewerDidAuthor
            author { id login name }
            reactionGroups { content users { totalCount } }
          }
          pageInfo { endCursor hasNextPage }
        }
        issueType { color description id name }
        labels { nodes { color description id name } totalCount }
        milestone { description dueOn number title }
        parent { id number repository { nameWithOwner } state url }
        projectCards { nodes { column { name } project { name } } totalCount }
        projectItems {
          totalCount
          nodes { fieldValueByName { name optionId } id project { id title } }
        }
        reactionGroups { content users { totalCount } }
        subIssues {
          totalCount
          nodes { id number repository { nameWithOwner } state url }
        }
        subIssuesSummary { completed percentCompleted total }
      }
      pageInfo { endCursor hasNextPage }
    }
    labels {
      totalCount
      nodes { color createdAt description id isDefault name updatedAt url }
      pageInfo { endCursor hasNextPage }
    }
    languages { edges { node { name } size } }
    latestRelease { name publishedAt tagName url }
    licenseInfo { key name nickname }
    mentionableUsers { nodes { id login name } }
    milestones { nodes { description dueOn number title } }
    owner { id login }
    parent { id name owner { id login } }
    primaryLanguage { name }
    projects { nodes { body id name number resourcePath } }
    projectsV2 { nodes { closed id number resourcePath title url } }
    pullRequest {
      additions baseRefName baseRefOid body changedFiles closed closedAt
      createdAt deletions fullDatabaseId headRefName headRefOid id
      isCrossRepository isDraft maintainerCanModify mergeStateStatus
      mergeable mergedAt number reviewDecision state title updatedAt url
      assignees { nodes { databaseId id login name } totalCount }
      author { id login name }
      autoMergeRequest {
        authorEmail commitBody commitHeadline enabledAt mergeMethod
        enabledBy { id login name }
      }
      closingIssuesReferences {
        nodes { id number repository { id name owner { id login } } url }
        pageInfo { endCursor hasNextPage }
      }
      comments {
        totalCount
        nodes {
          authorAssociation body createdAt id includesCreatedEdit isMinimized
          minimizedReason url viewerDidAuthor
          author { id login name }
          reactionGroups { content users { totalCount } }
        }
        pageInfo { endCursor hasNextPage }
      }
      commits {
        totalCount
        nodes {
          commit {
            authoredDate committedDate messageBody messageHeadline oid
            authors { nodes { email name user { id login } } }
            statusCheckRollup {
              contexts {
                nodes {
                  __typename completedAt conclusion context createdAt
                  description detailsUrl name startedAt state status
                  targetUrl
                  checkSuite { workflowRun { workflow { name } } }
                }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }
      }
      files { nodes { additions changeType deletions path } }
      headRepository { id name nameWithOwner }
      headRepositoryOwner { id login name }
      labels { nodes { color description id name } totalCount }
      latestReviews {
        nodes { author { login } authorAssociation body state submittedAt }
      }
      mergeCommit { oid }
      mergedBy { id login name }
      milestone { description dueOn number title }
      potentialMergeCommit { oid }
      projectCards { nodes { column { name } project { name } } totalCount }
      reactionGroups { content users { totalCount } }
      reviewRequests {
        nodes {
          requestedReviewer {
            __typename login name slug
            organization { login }
          }
        }
      }
      reviews {
        totalCount
        nodes {
          authorAssociation body id state submittedAt
          author { login }
          commit { oid }
          reactionGroups { content users { totalCount } }
        }
        pageInfo { endCursor hasNextPage }
      }
    }
    pullRequestTemplates { body filename }
    pullRequests {
      totalCount
      nodes {
        additions baseRefName baseRefOid body changedFiles closed closedAt
        createdAt deletions fullDatabaseId headRefName headRefOid id
        isCrossRepository isDraft maintainerCanModify mergeStateStatus
        mergeable mergedAt number reviewDecision state title updatedAt url
        assignees { nodes { databaseId id login name } totalCount }
        author { id login name }
        autoMergeRequest {
          authorEmail commitBody commitHeadline enabledAt mergeMethod
          enabledBy { id login name }
        }
        closingIssuesReferences {
          nodes { id number repository { id name owner { id login } } url }
          pageInfo { endCursor hasNextPage }
        }
        comments {
          totalCount
          nodes {
            authorAssociation body createdAt id includesCreatedEdit
            isMinimized minimizedReason url viewerDidAuthor
            author { id login name }
            reactionGroups { content users { totalCount } }
          }
          pageInfo { endCursor hasNextPage }
        }
        commits {
          nodes {
            commit {
              authoredDate committedDate messageBody messageHeadline oid
              authors { nodes { email name user { id login } } }
              statusCheckRollup {
                contexts {
                  nodes {
                    __typename completedAt conclusion context createdAt
                    description detailsUrl name startedAt state status
                    targetUrl
                    checkSuite { workflowRun { workflow { name } } }
                  }
                  pageInfo { endCursor hasNextPage }
                }
              }
            }
          }
        }
        files { nodes { additions changeType deletions path } }
        headRepository { id name nameWithOwner }
        headRepositoryOwner { id login name }
        labels { nodes { color description id name } totalCount }
        latestReviews {
          nodes { author { login } authorAssociation body state submittedAt }
        }
        mergeCommit { oid }
        mergedBy { id login name }
        milestone { description dueOn number title }
        potentialMergeCommit { oid }
        projectCards { nodes { column { name } project { name } } totalCount }
        projectItems {
          totalCount
          nodes { fieldValueByName { name optionId } id project { id title } }
        }
        reactionGroups { content users { totalCount } }
        reviewRequests {
          nodes {
            requestedReviewer {
              __typename login name slug
              organization { login }
            }
          }
        }
        reviews {
          totalCount
          nodes {
            authorAssociation body id state submittedAt
            author { login }
            commit { oid }
            reactionGroups { content users { totalCount } }
          }
          pageInfo { endCursor hasNextPage }
        }
      }
      pageInfo { endCursor hasNextPage }
    }
    release { databaseId isDraft }
    releases {
      nodes {
        createdAt immutable isDraft isLatest isPrerelease name publishedAt
        tagName
      }
      pageInfo { endCursor hasNextPage }
    }
    repositoryTopics { nodes { topic { name } } }
    templateRepository { id name owner { id login } }
    watchers { totalCount }
  }
  viewer { login }
}`;

/**
 * Titles of the issues linked to an issue as its parent, sub-issues or
 * dependencies, which gh 2.102 selects for `issue view` and `issue list
 * --json`. A dependency may be an issue of any owner (GitHub accepts one in
 * another account's repository), and a parent or sub-issue one of the same
 * owner but not necessarily in githubRepos, so these titles are text written
 * outside githubRepos. gh selects all four together, so allowing only the
 * same-owner ones would not let `issue view` through. The rest of each linked
 * issue (id, number, state, URL, repository name) is in GITHUB_FIELDS.
 * Allowed only with `trustLinkedIssues`.
 */
const LINKED_ISSUE_TITLES = `{
  repository {
    issueOrPullRequest { ...linked }
    issues { nodes { ...linked } }
  }
}
fragment linked on Issue {
  parent { title }
  subIssues { nodes { title } }
  blockedBy { nodes { title } }
  blocking { nodes { title } }
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
const linkedTitles = allowedPaths(LINKED_ISSUE_TITLES);
const allowedWithLinked = {
  leaves: new Set([...allowed.leaves, ...linkedTitles.leaves]),
  inner: new Set([...allowed.inner, ...linkedTitles.inner]),
};

/** The leaves of GITHUB_FIELDS, for tests that tie them to gh's queries. */
export const GITHUB_LEAF_PATHS: ReadonlySet<string> = allowed.leaves;
/** The leaves `trustLinkedIssues` adds. */
export const LINKED_TITLE_LEAF_PATHS: ReadonlySet<string> = linkedTitles.leaves;

export interface GraphqlOptions {
  /** Allow the titles of linked issues, which may come from any repository. */
  trustLinkedIssues?: boolean;
}

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
  options: GraphqlOptions = {},
): GraphqlVerdict {
  const paths = options.trustLinkedIssues ? allowedWithLinked : allowed;
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

  // Every violation is reported, not just the first: the reason is what a
  // reviewer reads before approving, and a list that stops early would hide
  // the rest of what the document fetches.
  const problems: string[] = [];
  const others = [
    ...new Set(analysed.operations.filter((op) => op !== "query")),
  ];
  if (others.length > 0) {
    problems.push(
      `only GraphQL queries are allowed (found ${others.join(", ")})`,
    );
  }
  // A field outside the list is reported once, at its topmost path; its
  // children are outside too and would only repeat it. Parents come before
  // their children in `fields`.
  const outside: string[] = [];
  const within = (path: string) =>
    outside.some((p) => path === p || path.startsWith(`${p}/`));
  const repos = new Set<string>();
  for (const o of analysed.fields) {
    const ok = o.leaf ? paths.leaves.has(o.path) : paths.inner.has(o.path);
    if (!ok) {
      if (!within(o.path)) outside.push(o.path);
      continue;
    }
    if (o.path === REPOSITORY_PATH) {
      const owner = o.args.get("owner");
      const name = o.args.get("name");
      if (owner === undefined || name === undefined) {
        repos.add("GraphQL repository needs owner and name strings");
      } else if (!isRepoAllowed(owner, name)) {
        repos.add(`${owner}/${name} is not an allowed repository`);
      }
    }
  }
  if (outside.length === 1) {
    problems.push(`GraphQL field ${outside[0]} is not allowed`);
  } else if (outside.length > 1) {
    problems.push(`GraphQL fields ${outside.join(", ")} are not allowed`);
  }
  problems.push(...repos);
  return problems.length === 0
    ? { ok: true }
    : { ok: false, reason: problems.join("; ") };
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
