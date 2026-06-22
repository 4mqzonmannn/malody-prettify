import * as vscode from 'vscode';
import { validateMcAst } from './validator';
import { ChartPreviewPanel } from './chartPreview';

const parseJSON = require('json-to-ast');
const regLineSeperator = /\n|\r\n/;

let eol = '\n';
let tab = '    ';

let statusBarPrettify: vscode.StatusBarItem;
let diagnosticCollection: vscode.DiagnosticCollection;

enum CollapseType {
	NoCollapse = 0,
	CollapseObjectWithSpace,
	CollapseArrayWithoutSpace,
}

class VisitorState {
	scope : string;
	indent : number;
	collapse : CollapseType;
	arrayIndentString : string;
	objectIndentString : string;
	arraySplitString : string;
	objectSplitString : string;
	constructor(scope : string, indent : number, collapse : CollapseType) {
		this.scope = scope;
		this.indent = indent;
		this.collapse = collapse;
		this.arrayIndentString = collapse === CollapseType.CollapseArrayWithoutSpace ? '' : tab.repeat(Math.max(0, indent - 1)); // No indent on top level object
		this.objectIndentString = collapse === CollapseType.CollapseObjectWithSpace ? '' : this.arrayIndentString;
		this.arraySplitString = collapse === CollapseType.CollapseArrayWithoutSpace ? '' : eol;
		this.objectSplitString = collapse === CollapseType.CollapseObjectWithSpace ? ' ' : this.arraySplitString;
	}
	nextLevel(collapse? : CollapseType) : VisitorState {
		return new VisitorState(
			this.scope,
			this.indent + 1,
			collapse === undefined ? this.collapse : collapse
		);
	}
	nextScope(scope : string) : VisitorState {
		let fullScope = this.scope + '.' + scope;
		let collapse = getCollapseType(fullScope);
		return new VisitorState(
			fullScope,
			this.indent,
			collapse === undefined ? this.collapse : collapse
		);
	}
}

function getCollapseType(scope : string) : CollapseType | undefined {
	if (scope === 'root.time' || scope === 'root.effect' || scope === 'root.note') return CollapseType.CollapseObjectWithSpace;
	if (scope.endsWith('.beat') || scope.endsWith('.endbeat')) return CollapseType.CollapseArrayWithoutSpace;
	return undefined;
}

function visitor(ast : any, state : VisitorState) : string {
    let data = '';

    switch (ast.type) {
        case 'Object':
            data += '{' + state.objectSplitString;
            if (ast.hasOwnProperty('children')) {
				let items: string[] = [];
                ast.children.forEach((child: any) => {
                    items.push(visitor(child, state.nextLevel()));
                });
                data += items.join(',' + state.objectSplitString) + state.objectSplitString;
            }
            data += state.objectIndentString + '}';
            break;

        case 'Array':
            data += '[' + state.arraySplitString;
            if (ast.hasOwnProperty('children')) {
				let items: string[] = [];
				let nextState = state.nextLevel();
                ast.children.forEach((child: any) => {
					items.push(nextState.arrayIndentString + visitor(child, state.nextLevel()));
                });
                data += items.join(',' + state.arraySplitString) + state.arraySplitString;
            }
            data += state.arrayIndentString + ']';
            break;

        case 'Property':
			data += state.objectIndentString + ast.key.raw + ': ' +
				visitor(ast.value, state.nextScope(ast.key.value));
            break;

        case 'Literal':
            data += ast.raw;
            break;

        default:
            break;
    }

    return data;
}

export function prettify(data : string) : Promise<string> {
    return new Promise((resolve, reject) => {
        let ast = parseJSON(data, { loc: false });
        resolve(visitor(ast, new VisitorState('root', 0, CollapseType.NoCollapse)) + '\n');
    });
}

function commandPrettify() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	let tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;

	eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	tab = editor.options.insertSpaces ? ' '.repeat(tabSize) : '\t';

	const raw = editor.document.getText();

	new Promise<string>((resolve, reject) => {
		let ast = parseJSON(raw, { loc: false });
		resolve(visitor(ast, new VisitorState('root', 0, CollapseType.NoCollapse)) + '\n');
	}).then(content => {
		return editor.edit(builder => {
			const start = new vscode.Position(0, 0);
			const lines = raw.split(regLineSeperator);
			const end = new vscode.Position(lines.length, lines[lines.length - 1].length);
			const allRange = new vscode.Range(start, end);
			builder.replace(allRange, content);
		});
	}).then(success => {
		console.log('prettify mc finished');
	}).catch(reason => {
		console.error(reason);
	});
}

function updateStatusBar(): void {
	const isMc = vscode.window.activeTextEditor?.document.languageId === "malodychart";
	if (isMc) {
		statusBarPrettify.show();
	} else {
		statusBarPrettify.hide();
	}
}

/**
 * ドキュメントを json-to-ast でパースし、validateMcAst でバリデーションを実行して
 * DiagnosticCollection に結果をセットする。
 */
function validateMcDocument(document: vscode.TextDocument): void {
	if (document.languageId !== 'malodychart') return;

	const raw = document.getText();
	try {
		const ast = parseJSON(raw, { loc: true });
		const diagnostics = validateMcAst(ast);
		diagnosticCollection.set(document.uri, diagnostics);
	} catch (e: any) {
		const msg = e?.message ?? String(e);
		const lineMatch = msg.match(/(\d+):(\d+)/);
		let range = new vscode.Range(0, 0, 0, 0);
		if (lineMatch) {
			const line = Math.max(0, parseInt(lineMatch[1]) - 1);
			const col  = Math.max(0, parseInt(lineMatch[2]) - 1);
			range = new vscode.Range(line, col, line, col + 1);
		}
		diagnosticCollection.set(document.uri, [
			new vscode.Diagnostic(range, `JSON パースエラー: ${msg}`, vscode.DiagnosticSeverity.Error)
		]);
	}
}

export function activate(context: vscode.ExtensionContext) {
	const { subscriptions } = context;

	subscriptions.push(vscode.commands.registerCommand('malody.prettify', commandPrettify));

	statusBarPrettify = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarPrettify.text = "$(list-selection) Prettify MC";
	statusBarPrettify.command = 'malody.prettify';
	subscriptions.push(statusBarPrettify);

	// ── DiagnosticCollection ──────────────────────────────────
	diagnosticCollection = vscode.languages.createDiagnosticCollection('malodychart');
	subscriptions.push(diagnosticCollection);

	subscriptions.push(
		vscode.commands.registerCommand('malody.showChartPreview', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage('アクティブなエディタが見つかりません。');
				return;
			}
			if (editor.document.languageId !== 'malodychart') {
				vscode.window.showErrorMessage('.mc ファイルを開いた状態で実行してください。');
				return;
			}
			ChartPreviewPanel.show(context, editor.document);
		})
	);

	subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
		updateStatusBar();
		if (editor) {
			validateMcDocument(editor.document);
		}
	}));

	let updateTimeout: NodeJS.Timeout | undefined;
	subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
		const doc = e.document;
		if (doc.languageId === 'malodychart') {
			if (updateTimeout) {
				clearTimeout(updateTimeout);
			}
			updateTimeout = setTimeout(() => {
				validateMcDocument(doc);
				ChartPreviewPanel.refresh(doc);
			}, 300);
		}
	}));

	subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
		if (doc.languageId === 'malodychart') {
			validateMcDocument(doc);
			ChartPreviewPanel.refresh(doc);
		}
	}));

	subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
		validateMcDocument(doc);
	}));

	subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
		diagnosticCollection.delete(doc.uri);
	}));

	if (vscode.window.activeTextEditor) {
		validateMcDocument(vscode.window.activeTextEditor.document);
	}

	updateStatusBar();
}

export function deactivate() {
	diagnosticCollection?.dispose();
}
