import * as vscode from 'vscode';

interface AstNode {
    type: 'Object' | 'Array' | 'Property' | 'Literal';
    children?: AstNode[];
    key?: { value: string };
    value?: AstNode;
    raw?: string;
    loc?: {
        start: { line: number; column: number };
        end: { line: number; column: number };
    };
}

/**
 * AST ノードから vscode.Range を生成する。
 * loc が存在しない場合はドキュメント先頭を返す。
 */
function locToRange(node: AstNode): vscode.Range {
    if (node.loc) {
        const s = node.loc.start;
        const e = node.loc.end;
        return new vscode.Range(s.line - 1, s.column, e.line - 1, e.column);
    }
    return new vscode.Range(0, 0, 0, 0);
}

/**
 * Object AST の children から指定キーのプロパティを検索する。
 */
function findProperty(obj: AstNode, key: string): AstNode | undefined {
    if (obj.type !== 'Object' || !obj.children) return undefined;
    return obj.children.find(
        (c) => c.type === 'Property' && c.key?.value === key
    );
}

/**
 * プロパティの値ノードを取得する。
 */
function getPropValue(obj: AstNode, key: string): AstNode | undefined {
    const prop = findProperty(obj, key);
    return prop?.value;
}

/**
 * Literal ノードの数値を取得する。
 */
function getLiteralNumber(node: AstNode): number | undefined {
    if (node.type !== 'Literal' || node.raw === undefined) return undefined;
    const n = Number(node.raw);
    return isNaN(n) ? undefined : n;
}

/**
 * beat / endbeat が [整数, 整数, 整数] の形式か検証する。
 * ルール4, 5, 6, 10 に対応。
 */
function validateBeat(beatNode: AstNode, fieldName: string, diagnostics: vscode.Diagnostic[]): void {
    if (beatNode.type !== 'Array') {
        diagnostics.push(new vscode.Diagnostic(
            locToRange(beatNode),
            `"${fieldName}" は配列 [小節, 分子, 分母] でなければなりません。`,
            vscode.DiagnosticSeverity.Error
        ));
        return;
    }

    const elems = beatNode.children ?? [];

    if (elems.length !== 3) {
        diagnostics.push(new vscode.Diagnostic(
            locToRange(beatNode),
            `"${fieldName}" は要素が 3 つの配列 [小節, 分子, 分母] でなければなりません（現在: ${elems.length} 要素）。`,
            vscode.DiagnosticSeverity.Error
        ));
        return;
    }

    elems.forEach((elem, i) => {
        const n = getLiteralNumber(elem);
        if (n === undefined || !Number.isInteger(n)) {
            diagnostics.push(new vscode.Diagnostic(
                locToRange(elem),
                `"${fieldName}[${i}]" は整数でなければなりません。`,
                vscode.DiagnosticSeverity.Error
            ));
        }
    });

    const denomNode = elems[2];
    const denom = getLiteralNumber(denomNode);
    if (denom === 0) {
        diagnostics.push(new vscode.Diagnostic(
            locToRange(denomNode),
            `"${fieldName}" の分母（3番目の要素）は 0 にできません。`,
            vscode.DiagnosticSeverity.Error
        ));
    }
}

/** 既知の Malody モード番号 */
const KNOWN_MODES = new Set([0, 1, 2, 3, 4, 5, 6]);
const MODE_NAMES: { [key: number]: string } = {
    0: 'Key',
    1: 'Step',
    2: 'Catch',
    3: 'Pad',
    4: 'Taiko',
    5: 'Ring',
    6: 'Slide',
};

/**
 * .mc ファイルの AST 全体を検証し、Diagnostic の配列を返す。
 *
 * @param ast      json-to-ast でパースした AST（loc: true で取得したもの）
 * @returns        検出した問題のリスト
 */
export function validateMcAst(ast: AstNode): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];

    if (ast.type !== 'Object') {
        diagnostics.push(new vscode.Diagnostic(
            new vscode.Range(0, 0, 0, 0),
            'ファイルのトップレベルは JSON オブジェクト {} でなければなりません。',
            vscode.DiagnosticSeverity.Error
        ));
        return diagnostics;
    }

    const metaProp = findProperty(ast, 'meta');
    if (!metaProp || !metaProp.value) {
        diagnostics.push(new vscode.Diagnostic(
            locToRange(ast),
            '"meta" セクションが見つかりません。Malody 譜面には必須のセクションです。',
            vscode.DiagnosticSeverity.Error
        ));
    } else {
        const meta = metaProp.value;

        const modeNode = getPropValue(meta, 'mode');
        if (modeNode) {
            const modeVal = getLiteralNumber(modeNode);
            if (modeVal === undefined || !KNOWN_MODES.has(modeVal)) {
                const knownList = [...KNOWN_MODES]
                    .map((m) => `${m}(${MODE_NAMES[m]})`)
                    .join(', ');
                diagnostics.push(new vscode.Diagnostic(
                    locToRange(modeNode),
                    `"meta.mode" の値 ${modeNode.raw} は未知のモードです。既知のモード: ${knownList}`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }
        }
    }

    const timeProp = findProperty(ast, 'time');
    if (!timeProp || !timeProp.value) {
        diagnostics.push(new vscode.Diagnostic(
            locToRange(ast),
            '"time" セクションが見つかりません。BPM 情報は必須です。',
            vscode.DiagnosticSeverity.Error
        ));
    } else {
        const timeArr = timeProp.value;
        if (timeArr.type !== 'Array') {
            diagnostics.push(new vscode.Diagnostic(
                locToRange(timeArr),
                '"time" は配列でなければなりません。',
                vscode.DiagnosticSeverity.Error
            ));
        } else {
            (timeArr.children ?? []).forEach((entry, idx) => {
                if (entry.type !== 'Object') return;

                const beatNode = getPropValue(entry, 'beat');
                if (beatNode) {
                    validateBeat(beatNode, `time[${idx}].beat`, diagnostics);
                }

                const bpmNode = getPropValue(entry, 'bpm');
                if (bpmNode) {
                    const bpm = getLiteralNumber(bpmNode);
                    if (bpm === undefined) {
                        diagnostics.push(new vscode.Diagnostic(
                            locToRange(bpmNode),
                            `"time[${idx}].bpm" は数値でなければなりません。`,
                            vscode.DiagnosticSeverity.Error
                        ));
                    } else if (bpm <= 0) {
                        diagnostics.push(new vscode.Diagnostic(
                            locToRange(bpmNode),
                            `"time[${idx}].bpm" は正の数値でなければなりません（現在: ${bpm}）。`,
                            vscode.DiagnosticSeverity.Error
                        ));
                    }
                } else {
                    diagnostics.push(new vscode.Diagnostic(
                        locToRange(entry),
                        `"time[${idx}]" に "bpm" フィールドがありません。`,
                        vscode.DiagnosticSeverity.Error
                    ));
                }
            });
        }
    }

    const noteProp = findProperty(ast, 'note');
    if (!noteProp || !noteProp.value) {
        diagnostics.push(new vscode.Diagnostic(
            locToRange(ast),
            '"note" セクションが見つかりません。',
            vscode.DiagnosticSeverity.Warning
        ));
    } else {
        const noteArr = noteProp.value;
        if (noteArr.type !== 'Array') {
            diagnostics.push(new vscode.Diagnostic(
                locToRange(noteArr),
                '"note" は配列でなければなりません。',
                vscode.DiagnosticSeverity.Error
            ));
        } else {
            (noteArr.children ?? []).forEach((entry, idx) => {
                if (entry.type !== 'Object') return;

                const beatNode = getPropValue(entry, 'beat');
                if (beatNode) {
                    validateBeat(beatNode, `note[${idx}].beat`, diagnostics);
                }

                const endbeatNode = getPropValue(entry, 'endbeat');
                if (endbeatNode) {
                    validateBeat(endbeatNode, `note[${idx}].endbeat`, diagnostics);
                }

                const columnNode = getPropValue(entry, 'column');
                if (columnNode) {
                    const col = getLiteralNumber(columnNode);
                    if (col === undefined || !Number.isInteger(col)) {
                        diagnostics.push(new vscode.Diagnostic(
                            locToRange(columnNode),
                            `"note[${idx}].column" は整数でなければなりません。`,
                            vscode.DiagnosticSeverity.Warning
                        ));
                    } else if (col < 0) {
                        diagnostics.push(new vscode.Diagnostic(
                            locToRange(columnNode),
                            `"note[${idx}].column" は 0 以上でなければなりません（現在: ${col}）。`,
                            vscode.DiagnosticSeverity.Warning
                        ));
                    }
                }
            });
        }
    }

    return diagnostics;
}
