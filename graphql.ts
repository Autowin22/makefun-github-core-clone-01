import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  repos,
  viewerLogin,
  learnViewerLogin,
  findRepo,
  mergePullRequestInRepo,
  getNextObjectId,
  getNextSeq,
  nowIso,
  requestId,
  readObject,
  writeObject,
  parseTree,
  parseCommit,
  flattenTree,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 32 * 1024 * 1024) {
      throw new Error('Payload too large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ==========================================
// 1. LEXER & PARSER
// ==========================================

export type Token쏟Type =
  | 'NAME'
  | 'INT'
  | 'FLOAT'
  | 'STRING'
  | 'PUNCTUATION'
  | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
}

function lex(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < query.length) {
    const c = query[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < query.length && query[i] !== '\n' && query[i] !== '\r') {
        i++;
      }
      continue;
    }
    if ('{}()[]:!=@$'.includes(c) || c === '&' || c === '|') {
      tokens.push({ type: 'PUNCTUATION', value: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === '.' && query.substring(i, i + 3) === '...') {
      tokens.push({ type: 'PUNCTUATION', value: '...', start: i, end: i + 3 });
      i += 3;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let strVal = '';
      while (i < query.length) {
        if (query[i] === '"') {
          i++;
          break;
        }
        if (query[i] === '\\' && i + 1 < query.length) {
          i++;
          const esc = query[i];
          if (esc === 'n') strVal += '\n';
          else if (esc === 't') strVal += '\t';
          else if (esc === '"') strVal += '"';
          else if (esc === '\\') strVal += '\\';
          else strVal += esc;
          i++;
        } else {
          strVal += query[i];
          i++;
        }
      }
      tokens.push({ type: 'STRING', value: strVal, start, end: i });
      continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      const start = i;
      while (
        i < query.length &&
        ((query[i] >= 'a' && query[i] <= 'z') ||
          (query[i] >= 'A' && query[i] <= 'Z') ||
          (query[i] >= '0' && query[i] <= '9') ||
          query[i] === '_')
      ) {
        i++;
      }
      const value = query.substring(start, i);
      tokens.push({ type: 'NAME', value, start, end: i });
      continue;
    }
    if ((c >= '0' && c <= '9') || c === '-') {
      const start = i;
      i++;
      let isFloat = false;
      while (i < query.length && ((query[i] >= '0' && query[i] <= '9') || query[i] === '.')) {
        if (query[i] === '.') isFloat = true;
        i++;
      }
      const value = query.substring(start, i);
      tokens.push({ type: isFloat ? 'FLOAT' : 'INT', value, start, end: i });
      continue;
    }
    tokens.push({ type: 'PUNCTUATION', value: c, start: i, end: i + 1 });
    i++;
  }
  tokens.push({ type: 'EOF', value: '', start: query.length, end: query.length });
  return tokens;
}

export interface ASTNode {
  kind: string;
  [key: string]: any;
}

class Parser {
  private tokens: Token[];
  private idx = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.idx] ?? this.tokens[this.tokens.length - 1];
  }

  private next(): Token {
    const t = this.peek();
    if (this.idx < this.tokens.length - 1) {
      this.idx++;
    }
    return t;
  }

  private match(value: string): boolean {
    if (this.peek().value === value) {
      this.next();
      return true;
    }
    return false;
  }

  private expect(value: string): Token {
    const t = this.next();
    if (t.value !== value && t.type !== value) {
      throw new Error(`Expected ${value}, got ${t.value}`);
    }
    return t;
  }

  public parseDocument(): ASTNode {
    const definitions: ASTNode[] = [];
    while (this.peek().type !== 'EOF') {
      definitions.push(this.parseDefinition());
    }
    return { kind: 'Document', definitions };
  }

  private parseDefinition(): ASTNode {
    const peekVal = this.peek().value;
    if (peekVal === 'query' || peekVal === 'mutation') {
      return this.parseOperationDefinition();
    }
    if (peekVal === 'fragment') {
      return this.parseFragmentDefinition();
    }
    if (peekVal === '{') {
      return this.parseOperationDefinition();
    }
    throw new Error(`Unexpected definition starting with ${peekVal}`);
  }

  private parseOperationDefinition(): ASTNode {
    let operation = 'query';
    let name: string | undefined = undefined;
    const peekVal = this.peek().value;

    if (peekVal === 'query' || peekVal === 'mutation') {
      operation = this.next().value;
      if (this.peek().type === 'NAME') {
        name = this.next().value;
      }
    }

    const variableDefinitions: ASTNode[] = [];
    if (this.peek().value === '(') {
      this.next();
      while (this.peek().value !== ')') {
        variableDefinitions.push(this.parseVariableDefinition());
        this.match(',');
      }
      this.expect(')');
    }

    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();

    return {
      kind: 'OperationDefinition',
      operation,
      name,
      variableDefinitions,
      directives,
      selectionSet,
    };
  }

  private parseVariableDefinition(): ASTNode {
    this.expect('$');
    const variable = { kind: 'Variable', name: this.expect('NAME').value };
    this.expect(':');
    const type = this.parseType();
    let defaultValue: any = undefined;
    if (this.match('=')) {
      defaultValue = this.parseValueLiteral();
    }
    return { kind: 'VariableDefinition', variable, type, defaultValue };
  }

  private parseType(): ASTNode {
    if (this.match('[')) {
      const type = this.parseType();
      this.expect(']');
      let nonNull = false;
      if (this.match('!')) nonNull = true;
      return { kind: 'ListType', type, nonNull };
    }
    const name = this.expect('NAME').value;
    let nonNull = false;
    if (this.match('!')) nonNull = true;
    return { kind: 'NamedType', name: { kind: 'Name', value: name }, nonNull };
  }

  private parseFragmentDefinition(): ASTNode {
    this.expect('fragment');
    const name = this.expect('NAME').value;
    this.expect('on');
    const typeCondition = { kind: 'NamedType', name: { kind: 'Name', value: this.expect('NAME').value } };
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'FragmentDefinition', name: { kind: 'Name', value: name }, typeCondition, directives, selectionSet };
  }

  private parseSelectionSet(): ASTNode {
    this.expect('{');
    const selections: ASTNode[] = [];
    while (this.peek().value !== '}' && this.peek().type !== 'EOF') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return { kind: 'SelectionSet', selections };
  }

  private parseSelection(): ASTNode {
    if (this.peek().value === '...') {
      this.next();
      if (this.peek().value === 'on') {
        this.next();
        const typeCondition = { kind: 'NamedType', name: { kind: 'Name', value: this.expect('NAME').value } };
        const directives = this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        return { kind: 'InlineFragment', typeCondition, directives, selectionSet };
      } else if (this.peek().type === 'NAME') {
        const name = this.expect('NAME').value;
        const directives = this.parseDirectives();
        return { kind: 'FragmentSpread', name: { kind: 'Name', value: name }, directives };
      } else {
        throw new Error('Invalid spread');
      }
    }

    let alias: string | undefined = undefined;
    let nameToken = this.expect('NAME');
    let name = nameToken.value;

    if (this.match(':')) {
      alias = name;
      name = this.expect('NAME').value;
    }

    const argumentsList = this.parseArguments();
    const directives = this.parseDirectives();
    let selectionSet: ASTNode | undefined = undefined;
    if (this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }

    return {
      kind: 'Field',
      alias: alias ? { kind: 'Name', value: alias } : undefined,
      name: { kind: 'Name', value: name },
      arguments: argumentsList,
      directives,
      selectionSet,
    };
  }

  private parseArguments(): ASTNode[] {
    const args: ASTNode[] = [];
    if (this.peek().value === '(') {
      this.next();
      while (this.peek().value !== ')' && this.peek().type !== 'EOF') {
        const name = this.expect('NAME').value;
        this.expect(':');
        const value = this.parseValueLiteral();
        args.push({ kind: 'Argument', name: { kind: 'Name', value: name }, value });
        this.match(',');
      }
      this.expect(')');
    }
    return args;
  }

  private parseValueLiteral(): any {
    const t = this.peek();
    if (t.value === '[') {
      this.next();
      const items: any[] = [];
      while (this.peek().value !== ']' && this.peek().type !== 'EOF') {
        items.push(this.parseValueLiteral());
        this.match(',');
      }
      this.expect(']');
      return { kind: 'ListValue', values: items };
    }
    if (t.value === '{') {
      this.next();
      const fields: any[] = [];
      while (this.peek().value !== '}' && this.peek().type !== 'EOF') {
        const fieldName = this.expect('NAME').value;
        this.expect(':');
        const fieldValue = this.parseValueLiteral();
        fields.push({ kind: 'ObjectField', name: { kind: 'Name', value: fieldName }, value: fieldValue });
        this.match(',');
      }
      this.expect('}');
      return { kind: 'ObjectValue', fields };
    }
    if (t.value === '$') {
      this.next();
      return { kind: 'Variable', name: this.expect('NAME').value };
    }
    if (t.type === 'STRING') {
      this.next();
      return { kind: 'StringValue', value: t.value };
    }
    if (t.type === 'INT') {
      this.next();
      return { kind: 'IntValue', value: parseInt(t.value, 10) };
    }
    if (t.type === 'FLOAT') {
      this.next();
      return { kind: 'FloatValue', value: parseFloat(t.value) };
    }
    if (t.type === 'NAME') {
      this.next();
      if (t.value === 'true') return { kind: 'BooleanValue', value: true };
      if (t.value === 'false') return { kind: 'BooleanValue', value: false };
      if (t.value === 'null') return { kind: 'NullValue' };
      return { kind: 'EnumValue', value: t.value };
    }
    throw new Error(`Unexpected value token ${t.value}`);
  }

  private parseDirectives(): ASTNode[] {
    const directives: ASTNode[] = [];
    while (this.peek().value === '@') {
      this.next();
      const name = this.expect('NAME').value;
      const args = this.parseArguments();
      directives.push({ kind: 'Directive', name: { kind: 'Name', value: name }, arguments: args });
    }
    return directives;
  }
}

// ==========================================
// 2. GLOBAL ID & HELPERS
// ==========================================

function encodeGlobalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`).toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { type: decoded.substring(0, idx), key: decoded.substring(idx + 1) };
  } catch {
    return null;
  }
}

// ==========================================
// 3. INTROSPECTION SCHEMA MODEL
// ==========================================

const SCHEMA_TYPES: Record<string, any> = {
  Issue: {
    __typename: '__Type',
    name: 'Issue',
    fields: [
      { __typename: '__Field', name: 'id' },
      { __typename: '__Field', name: 'number' },
      { __typename: '__Field', name: 'title' },
      { __typename: '__Field', name: 'body' },
      { __typename: '__Field', name: 'state' },
      { __typename: '__Field', name: 'stateReason' },
      { __typename: '__Field', name: 'url' },
      { __typename: '__Field', name: 'createdAt' },
      { __typename: '__Field', name: 'updatedAt' },
      { __typename: '__Field', name: 'closedAt' },
      { __typename: '__Field', name: 'author' },
      { __typename: '__Field', name: 'labels' },
      { __typename: '__Field', name: 'comments' },
      { __typename: '__Field', name: 'repository' }
    ],
  },
  PullRequest: {
    __typename: '__Type',
    name: 'PullRequest',
    fields: [
      { __typename: '__Field', name: 'id' },
      { __typename: '__Field', name: 'number' },
      { __typename: '__Field', name: 'title' },
      { __typename: '__Field', name: 'body' },
      { __typename: '__Field', name: 'state' },
      { __typename: '__Field', name: 'merged' },
      { __typename: '__Field', name: 'mergedAt' },
      { __typename: '__Field', name: 'url' },
      { __typename: '__Field', name: 'createdAt' },
      { __typename: '__Field', name: 'updatedAt' },
      { __typename: '__Field', name: 'closedAt' },
      { __typename: '__Field', name: 'author' },
      { __typename: '__Field', name: 'headRefName' },
      { __typename: '__Field', name: 'baseRefName' }
    ],
  },
  Repository: {
    __typename: '__Type',
    name: 'Repository',
    fields: [
      { __typename: '__Field', name: 'id' },
      { __typename: '__Field', name: 'name' },
      { __typename: '__Field', name: 'nameWithOwner' },
      { __typename: '__Field', name: 'owner' },
      { __typename: '__Field', name: 'description' },
      { __typename: '__Field', name: 'url' },
      { __typename: '__Field', name: 'createdAt' },
      { __typename: '__Field', name: 'updatedAt' },
      { __typename: '__Field', name: 'isPrivate' },
      { __typename: '__Field', name: 'defaultBranchRef' },
      { __typename: '__Field', name: 'issues' },
      { __typename: '__Field', name: 'issue' },
      { __typename: '__Field', name: 'pullRequests' },
      { __typename: '__Field', name: 'pullRequest' },
      { __typename: '__Field', name: 'refs' },
      { __typename: '__Field', name: 'ref' },
      { __typename: '__Field', name: 'object' },
      { __typename: '__Field', name: 'viewerPermission' }
    ],
  },
  SearchType: {
    __typename: '__Type',
    name: 'SearchType',
    enumValues: [
      { __typename: '__EnumValue', name: 'ISSUE' },
      { __typename: '__EnumValue', name: 'REPOSITORY' },
      { __typename: '__EnumValue', name: 'PULL_REQUEST' }
    ],
  },
};

// ==========================================
// 4. EXECUTOR
// ==========================================

class ExecutionContext {
  public errors: { message: string; path?: (string | number)[] }[] = [];
  public variables: Record<string, any>;
  public fragments: Record<string, ASTNode> = {};

  constructor(variables: Record<string, any>, fragments: Record<string, ASTNode>) {
    this.variables = variables;
    this.fragments = fragments;
  }

  public addError(message: string, path?: (string | number)[]) {
    this.errors.push({ message, ...(path ? { path } : {}) });
  }
}

function evaluateValue(valNode: any, variables: Record<string, any>): any {
  if (!valNode) return undefined;
  switch (valNode.kind) {
    case 'StringValue':
    case 'IntValue':
    case 'FloatValue':
    case 'BooleanValue':
      return valNode.value;
    case 'NullValue':
      return null;
    case 'EnumValue':
      return valNode.value;
    case 'Variable':
      return variables[valNode.name];
    case 'ListValue':
      return valNode.values.map((v: any) => evaluateValue(v, variables));
    case 'ObjectValue': {
      const obj: Record<string, any> = {};
      for (const f of valNode.fields) {
        obj[f.name.value] = evaluateValue(f.value, variables);
      }
      return obj;
    }
    default:
      return undefined;
  }
}

async function executeSelection(
  selection: ASTNode,
  parentType: string,
  source: any,
  context: ExecutionContext,
  path: (string | number)[]
): Promise<[string, any][]> {
  const results: [string, any][] = [];

  if (selection.directives) {
    for (const dir of selection.directives) {
      const dirName = dir.name.value;
      if (dirName === 'include' || dirName === 'skip') {
        const ifArg = dir.arguments.find((a: any) => a.name.value === 'if');
        if (ifArg) {
          const ifVal = Boolean(evaluateValue(ifArg.value, context.variables));
          if (dirName === 'include' && !ifVal) return [];
          if (dirName === 'skip' && ifVal) return [];
        }
      }
    }
  }

  if (selection.kind === 'Field') {
    const fieldName = selection.name.value;
    const alias = selection.alias ? selection.alias.value : fieldName;
    const currentPath = [...path, alias];

    if (fieldName === '__typename') {
      return [[alias, parentType]];
    }

    const args: Record<string, any> = {};
    if (selection.arguments) {
      for (const arg of selection.arguments) {
        args[arg.name.value] = evaluateValue(arg.value, context.variables);
      }
    }

    try {
      const resolvedValue = await resolveField(source, parentType, fieldName, args, context, currentPath);
      if (resolvedValue !== undefined) {
        if (selection.selectionSet && resolvedValue !== null) {
          if (Array.isArray(resolvedValue)) {
            const evaluatedList = [];
            for (let idx = 0; idx < resolvedValue.length; idx++) {
              const item = resolvedValue[idx];
              const evaluatedItem = await executeSelectionSet(selection.selectionSet, getObjectType(item), item, context, [...currentPath, idx]);
              evaluatedList.push(evaluatedItem);
            }
            results.push([alias, evaluatedList]);
          } else {
            const evaluated = await executeSelectionSet(selection.selectionSet, getObjectType(resolvedValue), resolvedValue, context, currentPath);
            results.push([alias, evaluated]);
          }
        } else {
          results.push([alias, resolvedValue]);
        }
      }
    } catch (err: any) {
      context.addError(err.message ?? String(err), currentPath);
      results.push([alias, null]);
    }
  } else if (selection.kind === 'InlineFragment') {
    const typeCondition = selection.typeCondition ? selection.typeCondition.name.value : parentType;
    if (parentType === typeCondition || isSubType(parentType, typeCondition)) {
      const subResults = await executeSelectionSet(selection.selectionSet, parentType, source, context, path);
      for (const [k, v] of Object.entries(subResults)) {
        results.push([k, v]);
      }
    }
  } else if (selection.kind === 'FragmentSpread') {
    const fragName = selection.name.value;
    const frag = context.fragments[fragName];
    if (frag) {
      const typeCondition = frag.typeCondition.name.value;
      if (parentType === typeCondition || isSubType(parentType, typeCondition)) {
        const subResults = await executeSelectionSet(frag.selectionSet, parentType, source, context, path);
        for (const [k, v] of Object.entries(subResults)) {
          results.push([k, v]);
        }
      }
    }
  }

  return results;
}

function getObjectType(obj: any): string {
  if (obj === null || obj === undefined) return 'Null';
  if (typeof obj === 'object') {
    if (obj.__typename) return obj.__typename;
    if (obj.kind === 'issue') return 'Issue';
    if (obj.kind === 'pull') return 'PullRequest';
    if (obj.name && obj.refs && obj.issues) return 'Repository';
    if (obj.oid && obj.text !== undefined) return 'Blob';
    if (obj.entries) return 'Tree';
  }
  return 'Object';
}

function isSubType(actual: string, expected: string): boolean {
  return actual === expected;
}

async function executeSelectionSet(
  selectionSet: ASTNode,
  parentType: string,
  source: any,
  context: ExecutionContext,
  path: (string | number)[]
): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  for (const selection of selectionSet.selections) {
    const evaluatedPairs = await executeSelection(selection, parentType, source, context, path);
    for (const [alias, val] of evaluatedPairs) {
      result[alias] = val;
    }
  }
  return result;
}

// ==========================================
// 5. FIELD RESOLVERS
// ==========================================

async function resolveField(
  source: any,
  parentType: string,
  fieldName: string,
  args: Record<string, any>,
  context: ExecutionContext,
  path: (string | number)[]
): Promise<any> {
  // Introspection types
  if (parentType === '__Type') {
    if (fieldName === 'name') return source.name;
    if (fieldName === 'fields') return source.fields ?? [];
    if (fieldName === 'enumValues') return source.enumValues ?? [];
  }
  if (parentType === '__Field') {
    if (fieldName === 'name') return source.name;
  }
  if (parentType === '__EnumValue') {
    if (fieldName === 'name') return source.name;
  }
  if (parentType === '__Schema') {
    if (fieldName === 'types') return source.types;
    if (fieldName === 'queryType') return source.queryType;
    if (fieldName === 'mutationType') return source.mutationType;
  }

  // Root Query
  if (parentType === 'Query') {
    if (fieldName === 'viewer') {
      return { __typename: 'User', login: viewerLogin ?? 'viewer' };
    }
    if (fieldName === 'repository') {
      const owner = args.owner;
      const name = args.name;
      if (!owner || !name) return null;
      const repo = findRepo(owner, name);
      if (!repo) return null;
      return repo;
    }
    if (fieldName === 'node') {
      const id = args.id;
      if (!id) return null;
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.type === 'Repository') {
        const repo = findRepo('owner', decoded.key) || Array.from(repos.values()).find(r => r.name.toLowerCase() === decoded.key.toLowerCase());
        if (repo) return repo;
      } else if (decoded.type === 'Issue') {
        const [repoName, numStr] = decoded.key.split('#');
        const num = parseInt(numStr, 10);
        const repo = Array.from(repos.values()).find(r => r.name.toLowerCase() === repoName.toLowerCase());
        if (repo) {
          const iss = repo.issues.find(i => i.number === num);
          if (iss) {
            (iss as any).__repo = repo;
            return iss;
          }
        }
      } else if (decoded.type === 'PullRequest') {
        const [repoName, numStr] = decoded.key.split('#');
        const num = parseInt(numStr, 10);
        const repo = Array.from(repos.values()).find(r => r.name.toLowerCase() === repoName.toLowerCase());
        if (repo) {
          const pull = repo.pulls.find(p => p.number === num);
          if (pull) {
            (pull as any).__repo = repo;
            return pull;
          }
        }
      }
      return null;
    }
    if (fieldName === '__type') {
      const typeName = args.name;
      return SCHEMA_TYPES[typeName] ?? null;
    }
    if (fieldName === '__schema') {
      return {
        __typename: '__Schema',
        types: Object.values(SCHEMA_TYPES),
        queryType: { __typename: '__Type', name: 'Query' },
        mutationType: { __typename: '__Type', name: 'Mutation' },
      };
    }
  }

  // Root Mutation
  if (parentType === 'Mutation') {
    const input = args.input ?? {};
    if (fieldName === 'createIssue') {
      const repoId = input.repositoryId;
      const decoded = decodeGlobalId(repoId);
      if (!decoded) throw new Error('Invalid repositoryId');
      const repo = Array.from(repos.values()).find(r => r.name.toLowerCase() === decoded.key.toLowerCase());
      if (!repo) throw new Error('Repository not found');

      const title = input.title;
      if (!title) throw new Error('Title is required');

      const number = repo.nextNumber++;
      const issue: Issue = {
        id: getNextObjectId(),
        number,
        title,
        body: input.body ?? '',
        state: 'open',
        labels: [],
        user: { login: viewerLogin ?? 'adaiversen' },
        created_at: nowIso(),
        updated_at: nowIso(),
        comments: [],
        createdSeq: getNextSeq(),
        kind: 'issue',
      };
      repo.issues.push(issue);
      (issue as any).__repo = repo;
      return { issue };
    }
    if (fieldName === 'closeIssue') {
      const issueId = input.issueId;
      const decoded = decodeGlobalId(issueId);
      if (!decoded) throw new Error('Invalid issueId');
      const [repoName, numStr] = decoded.key.split('#');
      const num = parseInt(numStr, 10);
      const repo = Array.from(repos.values()).find(r => r.name.toLowerCase() === repoName.toLowerCase());
      if (!repo) throw new Error('Repository not found');
      const issue = repo.issues.find(i => i.number === num);
      if (!issue) throw new Error('Issue not found');

      issue.state = 'closed';
      issue.updated_at = nowIso();
      (issue as any).__repo = repo;
      return { issue };
    }
    if (fieldName === 'addComment') {
      const subjectId = input.subjectId;
      const decoded = decodeGlobalId(subjectId);
      if (!decoded) throw new Error('Invalid subjectId');
      const [repoName, numStr] = decoded.key.split('#');
      const num = parseInt(numStr, 10);
      const repo = Array.from(repos.values()).find(r => r.name.toLowerCase() === repoName.toLowerCase());
      if (!repo) throw new Error('Repository not found');
      const issue = repo.issues.find(i => i.number === num);
      if (!issue) throw new Error('Issue not found');

      const commentBody = input.body ?? '';
      const comment = {
        id: getNextObjectId(),
        body: commentBody,
        user: { login: viewerLogin ?? 'adaiversen' },
        created_at: nowIso(),
      };
      issue.comments.push(comment);
      return {
        commentEdge: {
          node: {
            id: comment.id,
            body: comment.body,
            author: comment.user,
            createdAt: comment.created_at,
          },
        },
      };
    }
    if (fieldName === 'createPullRequest') {
      const repoId = input.repositoryId;
      const decoded = decodeGlobalId(repoId);
      if (!decoded) throw new Error('Invalid repositoryId');
      const repo = Array.from(repos.values()).find(r => r.name.toLowerCase() === decoded.key.toLowerCase());
      if (!repo) throw new Error('Repository not found');

      const headRefName = input.headRefName;
      const baseRefName = input.baseRefName;
      const headTip = repo.refs.get(`refs/heads/${headRefName}`);
      const baseTip = repo.refs.get(`refs/heads/${baseRefName}`);
      if (!headTip || !baseTip) throw new Error('Head or base branch not found');

      const number = repo.nextNumber++;
      const pull: Pull = {
        id: getNextObjectId(),
        number,
        title: input.title,
        body: input.body ?? '',
        state: 'open',
        merged: false,
        head: { label: headRefName, ref: headRefName, sha: headTip },
        base: { label: baseRefName, ref: baseRefName, sha: baseTip },
        user: { login: viewerLogin ?? 'adaiversen' },
        created_at: nowIso(),
        updated_at: nowIso(),
        createdSeq: getNextSeq(),
        kind: 'pull',
      };
      repo.pulls.push(pull);
      (pull as any).__repo = repo;
      return { pullRequest: pull };
    }
    if (fieldName === 'mergePullRequest') {
      const pullRequestId = input.pullRequestId;
      const decoded = decodeGlobalId(pullRequestId);
      if (!decoded) throw new Error('Invalid pullRequestId');
      const [repoName, numStr] = decoded.key.split('#');
      const num = parseInt(numStr, 10);
      const repo = Array.from(repos.values()).find(r => r.name.toLowerCase() === repoName.toLowerCase());
      if (!repo) throw new Error('Repository not found');
      const pull = repo.pulls.find(p => p.number === num);
      if (!pull) throw new Error('Pull request not found');

      mergePullRequestInRepo(repo, pull);
      (pull as any).__repo = repo;
      return { pullRequest: pull };
    }
  }

  // Repository fields
  if (parentType === 'Repository' || (source && source.refs && source.issues)) {
    const repo: Repo = source;
    const ownerLogin = viewerLogin ?? 'adaiversen';

    if (fieldName === 'id') return encodeGlobalId('Repository', repo.name);
    if (fieldName === 'name') return repo.name;
    if (fieldName === 'nameWithOwner') return `${ownerLogin}/${repo.name}`;
    if (fieldName === 'owner') return { __typename: 'User', login: ownerLogin };
    if (fieldName === 'description') return repo.description;
    if (fieldName === 'url') return `/${ownerLogin}/${repo.name}`;
    if (fieldName === 'createdAt') return nowIso();
    if (fieldName === 'updatedAt') return nowIso();
    if (fieldName === 'isPrivate') return repo.private;
    if (fieldName === 'viewerPermission') return 'ADMIN';
    if (fieldName === 'defaultBranchRef') {
      const defBranch = repo.defaultBranch;
      const oid = repo.refs.get(`refs/heads/${defBranch}`) ?? repo.refs.get('refs/heads/main');
      return { name: defBranch, target: { oid: oid ?? '' } };
    }
    if (fieldName === 'issue') {
      const num = args.number;
      const iss = repo.issues.find(i => i.number === num);
      if (!iss) return null;
      (iss as any).__repo = repo;
      return iss;
    }
    if (fieldName === 'issues') {
      let issues = [...repo.issues];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        issues = issues.filter(i => states.includes(i.state.toUpperCase()));
      }
      issues.sort((a, b) => {
        const timeCmp = b.created_at.localeCompare(a.created_at);
        if (timeCmp !== 0) return timeCmp;
        return b.number - a.number;
      });

      const first = args.first ?? 10;
      let offset = 0;
      if (args.after) {
        try {
          offset = parseInt(Buffer.from(args.after, 'base64').toString('utf8'), 10) + 1;
        } catch {
          offset = 0;
        }
      }

      const slice = issues.slice(offset, offset + first);
      const hasNextPage = offset + first < issues.length;
      const endCursor = slice.length > 0 ? Buffer.from(String(offset + slice.length - 1)).toString('base64') : null;

      const edges = slice.map((iss, idx) => {
        (iss as any).__repo = repo;
        return {
          cursor: Buffer.from(String(offset + idx)).toString('base64'),
          node: iss,
        };
      });

      return {
        totalCount: issues.length,
        pageInfo: { hasNextPage, endCursor },
        edges,
        nodes: slice.map(iss => {
          (iss as any).__repo = repo;
          return iss;
        }),
      };
    }
    if (fieldName === 'pullRequest') {
      const num = args.number;
      const pull = repo.pulls.find(p => p.number === num);
      if (!pull) return null;
      (pull as any).__repo = repo;
      return pull;
    }
    if (fieldName === 'pullRequests') {
      let pulls = [...repo.pulls];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        pulls = pulls.filter(p => {
          const st = p.merged ? 'MERGED' : p.state.toUpperCase();
          return states.includes(st) || states.includes(p.state.toUpperCase());
        });
      }
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);

      const first = args.first ?? 10;
      let offset = 0;
      if (args.after) {
        try {
          offset = parseInt(Buffer.from(args.after, 'base64').toString('utf8'), 10) + 1;
        } catch {
          offset = 0;
        }
      }

      const slice = pulls.slice(offset, offset + first);
      const hasNextPage = offset + first < pulls.length;
      const endCursor = slice.length > 0 ? Buffer.from(String(offset + slice.length - 1)).toString('base64') : null;

      return {
        totalCount: pulls.length,
        pageInfo: { hasNextPage, endCursor },
        edges: slice.map((pull, idx) => {
          (pull as any).__repo = repo;
          return { cursor: Buffer.from(String(offset + idx)).toString('base64'), node: pull };
        }),
        nodes: slice.map(p => {
          (p as any).__repo = repo;
          return p;
        }),
      };
    }
    if (fieldName === 'ref') {
      const qName = args.qualifiedName;
      if (!qName) return null;
      const oid = repo.refs.get(qName);
      if (!oid) return null;
      const name = qName.replace(/^refs\/heads\//, '');
      return { name, target: { oid } };
    }
    if (fieldName === 'refs') {
      const prefix = args.refPrefix ?? 'refs/heads/';
      const refList: { name: string; target: { oid: string } }[] = [];
      for (const [refName, oid] of repo.refs.entries()) {
        if (refName.startsWith(prefix)) {
          const shortName = refName.replace(prefix, '');
          refList.push({ name: shortName, target: { oid } });
        }
      }
      return {
        nodes: refList,
        edges: refList.map(r => ({ node: r })),
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    }
    if (fieldName === 'object') {
      const expr = args.expression;
      if (!expr) return null;
      let commitSha = '';
      let filePath = '';
      if (expr.includes(':')) {
        const parts = expr.split(':');
        const branchOrOid = parts[0];
        filePath = parts.slice(1).join(':');
        commitSha = repo.refs.get(`refs/heads/${branchOrOid}`) ?? repo.refs.get(branchOrOid) ?? branchOrOid;
      } else {
        commitSha = repo.refs.get(`refs/heads/${expr}`) ?? repo.refs.get(expr) ?? expr;
      }

      const commitObj = readObject(commitSha);
      if (!commitObj) {
        const directObj = readObject(expr);
        if (directObj) {
          if (directObj.type === 'blob') {
            return { __typename: 'Blob', oid: expr, text: directObj.data.toString('utf8'), byteSize: directObj.data.length };
          }
          if (directObj.type === 'tree') {
            const entries = parseTree(directObj.data);
            return {
              __typename: 'Tree',
              entries: entries.map(e => ({
                name: e.name,
                type: e.mode.startsWith('4') || e.mode.startsWith('04') ? 'TREE' : 'BLOB',
                oid: e.sha,
              })),
            };
          }
        }
        return null;
      }

      if (commitObj.type === 'commit') {
        const commitData = parseCommit(commitObj.data);
        if (!filePath) {
          const treeObj = readObject(commitData.tree);
          if (!treeObj) return null;
          const entries = parseTree(treeObj.data);
          return {
            __typename: 'Tree',
            entries: entries.map(e => ({
              name: e.name,
              type: e.mode.startsWith('4') || e.mode.startsWith('04') ? 'TREE' : 'BLOB',
              oid: e.sha,
            })),
          };
        }
        const flat = flattenTree(commitData.tree, '');
        const entry = flat.get(filePath);
        if (entry) {
          const blobObj = readObject(entry.sha);
          if (blobObj) {
            return {
              __typename: 'Blob',
              oid: entry.sha,
              text: blobObj.data.toString('utf8'),
              byteSize: blobObj.data.length,
            };
          }
        }
      }
      return null;
    }
  }

  // Issue fields
  if (parentType === 'Issue' || (source && source.kind === 'issue')) {
    const issue: Issue = source;
    const repo: Repo = issue.__repo || Array.from(repos.values())[0];
    const repoName = repo ? repo.name : 'demo';
    const ownerLogin = viewerLogin ?? 'adaiversen';

    if (fieldName === 'id') return encodeGlobalId('Issue', `${repoName}#${issue.number}`);
    if (fieldName === 'number') return issue.number;
    if (fieldName === 'title') return issue.title;
    if (fieldName === 'body') return issue.body;
    if (fieldName === 'state') return issue.state.toUpperCase();
    if (fieldName === 'stateReason') return issue.state === 'closed' ? 'COMPLETED' : null;
    if (fieldName === 'url') return `/${ownerLogin}/${repoName}/issues/${issue.number}`;
    if (fieldName === 'createdAt') return issue.created_at;
    if (fieldName === 'updatedAt') return issue.updated_at;
    if (fieldName === 'closedAt') return issue.state === 'closed' ? issue.updated_at : null;
    if (fieldName === 'author') return { __typename: 'User', login: issue.user.login };
    if (fieldName === 'labels') {
      const first = args.first ?? 10;
      const slice = issue.labels.slice(0, first);
      return {
        nodes: slice,
        edges: slice.map(l => ({ node: l })),
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    }
    if (fieldName === 'comments') {
      const first = args.first ?? 10;
      const slice = issue.comments.slice(0, first);
      return {
        nodes: slice.map(c => ({
          id: c.id,
          body: c.body,
          author: c.user,
          createdAt: c.created_at,
        })),
        edges: slice.map(c => ({
          node: {
            id: c.id,
            body: c.body,
            author: c.user,
            createdAt: c.created_at,
          },
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    }
    if (fieldName === 'repository') return repo;
  }

  // PullRequest fields
  if (parentType === 'PullRequest' || (source && source.kind === 'pull')) {
    const pull: Pull = source;
    const repo: Repo = pull.__repo || Array.from(repos.values())[0];
    const repoName = repo ? repo.name : 'demo';
    const ownerLogin = viewerLogin ?? 'adaiversen';

    if (fieldName === 'id') return encodeGlobalId('PullRequest', `${repoName}#${pull.number}`);
    if (fieldName === 'number') return pull.number;
    if (fieldName === 'title') return pull.title;
    if (fieldName === 'body') return pull.body;
    if (fieldName === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    if (fieldName === 'merged') return pull.merged;
    if (fieldName === 'mergedAt') return pull.merged_at ?? null;
    if (fieldName === 'url') return `/${ownerLogin}/${repoName}/pull/${pull.number}`;
    if (fieldName === 'createdAt') return pull.created_at;
    if (fieldName === 'updatedAt') return pull.updated_at;
    if (fieldName === 'closedAt') return pull.state === 'closed' || pull.merged ? pull.updated_at : null;
    if (fieldName === 'author') return { __typename: 'User', login: pull.user.login };
    if (fieldName === 'headRefName') return pull.head.ref;
    if (fieldName === 'baseRefName') return pull.base.ref;
  }

  // User fields — viewer / owner / author all return { __typename: 'User', login }.
  // Previously served only by the generic fallback; the fallback now throws,
  // so User needs its own branch (fixes smoke test 1: { viewer { login } }).
  if (parentType === 'User') {
    if (fieldName === 'login') return source.login;
    if (fieldName === 'id') return encodeGlobalId('User', source.login ?? '');
  }

  // Generic fallback for plain-object results (issue/PR connections,
  // pageInfo, edges, ref targets): return the own property when present,
  // otherwise fall through to the unknown-field error below. This restores
  // the pre-regression behaviour without swallowing genuine unknown fields.
  if (source !== null && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, fieldName)) {
    return source[fieldName];
  }

  throw new Error(`Unknown field "${fieldName}" on type "${parentType}"`);
}

// ==========================================
// 6. HTTP HANDLER
// ==========================================

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const pathname = url.pathname;
  if (pathname !== '/api/graphql' && pathname !== '/api/v3/graphql') {
    return false;
  }

  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN;
  if (expectedToken) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return true;
    }
  }

  const method = req.method ?? 'POST';
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  let bodyText = '';
  try {
    bodyText = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Invalid payload' });
    return true;
  }

  let jsonBody: any;
  try {
    jsonBody = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    sendJson(res, 400, { message: 'Invalid JSON' });
    return true;
  }

  const isBatch = Array.isArray(jsonBody);
  const requests = isBatch ? jsonBody : [jsonBody];
  const results: any[] = [];

  for (const reqObj of requests) {
    const queryStr = reqObj.query;
    const variables = reqObj.variables ?? {};
    const operationName = reqObj.operationName;

    if (!queryStr || typeof queryStr !== 'string') {
      results.push({ data: null, errors: [{ message: 'Missing query' }] });
      continue;
    }

    try {
      const tokens = lex(queryStr);
      const parser = new Parser(tokens);
      const document = parser.parseDocument();

      let opDef: any = null;
      const fragments: Record<string, ASTNode> = {};

      for (const def of document.definitions) {
        if (def.kind === 'OperationDefinition') {
          if (!opDef || (operationName && def.name === operationName)) {
            opDef = def;
          }
        } else if (def.kind === 'FragmentDefinition') {
          fragments[def.name.value] = def;
        }
      }

      if (!opDef) {
        results.push({ data: null, errors: [{ message: 'No operation found' }] });
        continue;
      }

      const resolvedVars: Record<string, any> = { ...variables };
      if (opDef.variableDefinitions) {
        for (const varDef of opDef.variableDefinitions) {
          const varName = varDef.variable.name;
          if (resolvedVars[varName] === undefined && varDef.defaultValue !== undefined) {
            resolvedVars[varName] = evaluateValue(varDef.defaultValue, {});
          }
        }
      }

      const context = new ExecutionContext(resolvedVars, fragments);
      const operationType = opDef.operation;
      const rootType = operationType === 'mutation' ? 'Mutation' : 'Query';

      const data = await executeSelectionSet(opDef.selectionSet, rootType, null, context, []);

      const resultObj: any = { data };
      if (context.errors.length > 0) {
        resultObj.errors = context.errors;
      }
      results.push(resultObj);
    } catch (err: any) {
      results.push({
        data: null,
        errors: [{ message: err.message ?? String(err) }],
      });
    }
  }

  sendJson(res, 200, isBatch ? results : results[0]);
  return true;
}
