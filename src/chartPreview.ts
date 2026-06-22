import * as vscode from 'vscode';
import {
    buildTimingMap,
    buildEffectMap,
    calcAllNoteRenderInfos,
    getLastBeatF,
    calculateMainBpm,
    NoteRenderInfo
} from './previewEngine';

const parseJSON = require('json-to-ast');

export class ChartPreviewPanel {
    private static _panel: vscode.WebviewPanel | undefined;
    private static _document: vscode.TextDocument | undefined;

    static show(context: vscode.ExtensionContext, document: vscode.TextDocument): void {
        ChartPreviewPanel._document = document;
        const text = document.getText();
        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            vscode.window.showErrorMessage('JSONのパースに失敗しました。');
            return;
        }

        const timeArr   = json.time ?? [];
        const effectArr = json.effect ?? [];
        const noteArr   = json.note ?? [];

        const timingMap = buildTimingMap(timeArr);
        const effectMap = buildEffectMap(effectArr);
        
        const lastBeatF = getLastBeatF(noteArr);
        const mainBpm   = calculateMainBpm(timingMap, lastBeatF);

        const notesOn  = calcAllNoteRenderInfos(noteArr, effectMap, timingMap, true);
        const notesOff = calcAllNoteRenderInfos(noteArr, effectMap, timingMap, false);

        if (ChartPreviewPanel._panel) {
            ChartPreviewPanel._panel.reveal();
            ChartPreviewPanel._updateContent(notesOn, notesOff, effectMap, timingMap, mainBpm, ChartPreviewPanel._panel.webview);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'malodyChartPreview',
            'Chart Preview',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        ChartPreviewPanel._panel = panel;
        ChartPreviewPanel._updateContent(notesOn, notesOff, effectMap, timingMap, mainBpm, panel.webview);

        panel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'addEffect' || message.command === 'addRangeEffect') {
                const document = ChartPreviewPanel._document;
                if (!document) {
                    vscode.window.showErrorMessage('対象の譜面ファイルが見つかりません。');
                    return;
                }
                try {
                    const text = document.getText();
                    const json = JSON.parse(text);
                    if (!json.effect) json.effect = [];
                    
                    if (message.command === 'addEffect') {
                        const newEff: any = { beat: message.beat };
                        if (message.type === 'scroll') newEff.scroll = message.value;
                        else if (message.type === 'bpm') newEff.bpm = message.value;
                        json.effect.push(newEff);
                    } else if (message.command === 'addRangeEffect') {
                        const tToBeats = (b: number[]) => b[0] + (b[2] === 0 ? 0 : b[1] / b[2]);
                        const startBeat = message.startBeat;
                        const endBeat = message.endBeat;
                        const startVal = message.startVal;
                        const endVal = message.endVal;
                        const curve = message.curve;
                        const strength = message.strength || 2.0;
                        const count = message.count || 1;
                        
                        const startF = tToBeats(startBeat);
                        const endF = tToBeats(endBeat);
                        if (startF >= endF) {
                            vscode.window.showErrorMessage('始点は終点より手前である必要があります。');
                            return;
                        }

                        const beatsToT = (beats: number, den: number) => {
                            const measure = Math.floor(beats);
                            const rem = Math.max(0, beats - measure);
                            let num = Math.round(rem * den);
                            if (num >= den) { return [measure + 1, 0, 1]; }
                            if (num === 0) return [measure, 0, 1];
                            const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
                            const g = gcd(num, den);
                            return [measure, num / g, den / g];
                        };

                        const steps = count;
                        // Add effects
                        for (let i = 0; i <= steps; i++) {
                            const t = steps === 0 ? 1 : i / steps; // 0.0 to 1.0
                            let easedT = t;
                            if (curve === 'easeIn') easedT = Math.pow(t, strength);
                            else if (curve === 'easeOut') easedT = 1 - Math.pow(1 - t, strength);
                            else if (curve === 'easeInOut') {
                                easedT = t < 0.5 ? Math.pow(2, strength - 1) * Math.pow(t, strength) : 1 - Math.pow(-2 * t + 2, strength) / 2;
                            }

                            const val = startVal + (endVal - startVal) * easedT;
                            const currentBeatF = startF + i * ((endF - startF) / steps);
                            const beatArr = beatsToT(currentBeatF, 1920);
                            
                            const newEff: any = { beat: beatArr };
                            const finalVal = Math.round(val * 1000) / 1000;
                            if (message.type === 'scroll') newEff.scroll = finalVal;
                            else if (message.type === 'bpm') newEff.bpm = finalVal;
                            json.effect.push(newEff);
                        }
                    }
                    
                    json.effect.sort((a: any, b: any) => {
                        const m1 = a.beat[0] || 0;
                        const m2 = b.beat[0] || 0;
                        if (m1 !== m2) return m1 - m2;
                        const f1 = (a.beat[1] || 0) / (a.beat[2] || 1);
                        const f2 = (b.beat[1] || 0) / (b.beat[2] || 1);
                        return f1 - f2;
                    });
                    
                    const rawJson = JSON.stringify(json);
                    const { prettify } = require('./extension');
                    const formatted = await prettify(rawJson);
                    
                    const edit = new vscode.WorkspaceEdit();
                    const start = new vscode.Position(0, 0);
                    const endLine = document.lineCount - 1;
                    const end = document.lineAt(endLine).range.end;
                    edit.replace(document.uri, new vscode.Range(start, end), formatted);
                    await vscode.workspace.applyEdit(edit);
                    
                    let msgVal = message.value;
                    if (message.command === 'addRangeEffect') {
                        msgVal = `${message.startVal} -> ${message.endVal}`;
                    }
                    vscode.window.showInformationMessage(`Effect (${message.type}: ${msgVal}) を追加しました！`);
                } catch(e) {
                    vscode.window.showErrorMessage('Effectの追加に失敗しました: ' + e);
                }
            }
        });

        panel.onDidDispose(() => {
            ChartPreviewPanel._panel = undefined;
        });
    }

    static refresh(document: vscode.TextDocument): void {
        if (!ChartPreviewPanel._panel) return;
        const text = document.getText();
        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            return;
        }
        const timingMap = buildTimingMap(json.time ?? []);
        const effectMap = buildEffectMap(json.effect ?? []);
        
        const lastBeatF = getLastBeatF(json.note ?? []);
        const mainBpm   = calculateMainBpm(timingMap, lastBeatF);
        
        const notesOn   = calcAllNoteRenderInfos(json.note ?? [], effectMap, timingMap, true);
        const notesOff  = calcAllNoteRenderInfos(json.note ?? [], effectMap, timingMap, false);

        ChartPreviewPanel._updateContent(notesOn, notesOff, effectMap, timingMap, mainBpm, ChartPreviewPanel._panel.webview);
    }

    private static _updateContent(
        notesOn: NoteRenderInfo[],
        notesOff: NoteRenderInfo[],
        effectMap: any[],
        timingMap: any[],
        mainBpm: number,
        webview: vscode.Webview
    ): void {
        webview.html = buildHtml(notesOn, notesOff, effectMap, timingMap, mainBpm);
    }
}

function buildHtml(
    notesOn: NoteRenderInfo[],
    notesOff: NoteRenderInfo[],
    effectMap: any[],
    timingMap: any[],
    mainBpm: number
): string {
    return /* html */`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Malody Chart Preview</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background-color: #121212;
    color: #cdd6f4;
    font-family: sans-serif;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  header {
    background-color: #1e1e1e;
    padding: 10px;
    display: flex;
    align-items: center;
    border-bottom: 1px solid #333333;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  button {
    background: #2d2d2d;
    border: none;
    color: #e0e0e0;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  button:hover { background: #3d3d3d; }
  button.active { background: #89b4fa; color: #121212; }
  #container {
    flex: 1;
    position: relative;
    overflow: hidden;
    display: flex;
    justify-content: center;
  }
  canvas {
    background-color: #121212;
    width: 100%;
    height: 100%;
  }
</style>
</head>
<body>

<header>
  <div class="controls" style="margin-right: 20px;">
    <button id="btnPlay">▶</button>
    <button id="btnPause">⏸</button>
    <button id="btnReset">⏮</button>
  </div>
  <div class="controls">
    <button id="btnPrevMeasure">◀</button>
    <span style="font-size: 14px; width: 80px; text-align: center;">小節: <span id="lblMeasure">0</span></span>
    <button id="btnNextMeasure">▶</button>
  </div>
  <div class="controls" style="margin-left: auto;">
    <button id="btnEffectOn" class="active">Eff On</button>
    <button id="btnEffectOff">Eff Off</button>
  </div>
  <div class="controls" style="margin-left: 8px;">
    <button id="btnNodeStyle" class="active" style="width: 60px;">Dot</button>
  </div>
</header>
<div id="container">
  <canvas id="stage"></canvas>
  
  <!-- Overlay Controls (Canvas右上) -->
  <div style="position: absolute; top: 10px; right: 10px; display: flex; flex-direction: column; gap: 8px; z-index: 10;">
    <!-- Grid -->
    <div style="background: rgba(30, 30, 30, 0.85); padding: 8px 12px; border-radius: 6px; display: flex; align-items: center; justify-content: space-between; gap: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3);">
      <span style="font-size: 13px; font-weight: bold;">Grid: 1/</span>
      <input type="number" id="inpGrid" value="4" min="1" max="192" style="width: 60px; background: #1e1e1e; color: #e0e0e0; border: 1px solid #444; border-radius: 4px; padding: 4px; text-align: center; font-weight: bold;">
    </div>
    <!-- Mode -->
    <div style="background: rgba(30, 30, 30, 0.85); padding: 8px 12px; border-radius: 6px; display: flex; align-items: center; justify-content: space-between; gap: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3);">
      <span style="font-size: 13px; font-weight: bold;">Mode:</span>
      <select id="selMode" style="width: 100px; background: #1e1e1e; color: #e0e0e0; border: 1px solid #444; border-radius: 4px; padding: 4px; font-size: 13px;">
        <option value="view">View</option>
        <option value="edit">Add Effect</option>
      </select>
    </div>
  </div>
  
  <!-- Effect Input Modal (Single) -->
  <div id="effectModal" style="display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #1e1e1e; border: 1px solid #444; border-radius: 8px; padding: 16px; z-index: 20; box-shadow: 0 4px 12px rgba(0,0,0,0.5); width: 250px;">
    <h3 style="margin-bottom: 12px; font-size: 15px;">Add Effect</h3>
    <div style="margin-bottom: 8px; font-size: 13px;">
      <label>Beat: </label><span id="modBeatDisplay" style="font-family: monospace; background: #2d2d2d; padding: 2px 6px; border-radius: 3px;"></span>
    </div>
    <div style="margin-bottom: 8px; display: flex; flex-direction: column; gap: 4px;">
      <label style="font-size: 13px;">Type:</label>
      <select id="modType" style="background: #2d2d2d; color: #e0e0e0; border: 1px solid #444; padding: 4px; border-radius: 4px;">
        <option value="scroll">Scroll</option>
        <option value="bpm">BPM</option>
      </select>
    </div>
    <div style="margin-bottom: 16px; display: flex; flex-direction: column; gap: 4px;">
      <label style="font-size: 13px;">Value:</label>
      <input type="number" id="modValue" step="0.1" value="1.0" style="background: #2d2d2d; color: #e0e0e0; border: 1px solid #444; padding: 4px; border-radius: 4px;">
    </div>
    <div style="display: flex; justify-content: flex-end; gap: 8px;">
      <button id="btnModalCancel" style="background: #444;">Cancel</button>
      <button id="btnModalAdd" style="background: #89b4fa; color: #121212; font-weight: bold;">Add</button>
    </div>
  </div>

  <!-- Effect Range Input Modal (Bulk) -->
  <div id="rangeEffectModal" style="display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #1e1e1e; border: 1px solid #444; border-radius: 8px; padding: 16px; z-index: 20; box-shadow: 0 4px 12px rgba(0,0,0,0.5); width: 280px;">
    <h3 style="margin-bottom: 12px; font-size: 15px;">Add Effect Range</h3>
    <div style="margin-bottom: 8px; font-size: 13px; background: #2d2d2d; padding: 4px 8px; border-radius: 4px; color: #a6adc8;">
      Start: <span id="modRangeStartBeat" style="font-family: monospace;"></span><br>
      End: &nbsp;&nbsp;<span id="modRangeEndBeat" style="font-family: monospace;"></span>
    </div>
    <div style="margin-bottom: 8px; display: flex; gap: 8px;">
      <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
        <label style="font-size: 13px;">Type:</label>
        <select id="modRangeType" style="background: #2d2d2d; color: #e0e0e0; border: 1px solid #444; padding: 4px; border-radius: 4px;">
          <option value="scroll">Scroll</option>
          <option value="bpm">BPM</option>
        </select>
      </div>
      <div style="width: 70px; display: flex; flex-direction: column; gap: 4px;">
        <label style="font-size: 13px;">Count:</label>
        <input type="number" id="modRangeCount" step="1" value="4" min="1" max="1000" style="background: #2d2d2d; color: #e0e0e0; border: 1px solid #444; padding: 4px; border-radius: 4px;">
      </div>
    </div>
    <div style="margin-bottom: 8px; display: flex; gap: 8px;">
      <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
        <label style="font-size: 13px;">Start Value:</label>
        <input type="number" id="modRangeStartVal" step="0.1" value="1.0" style="background: #2d2d2d; color: #e0e0e0; border: 1px solid #444; padding: 4px; border-radius: 4px;">
      </div>
      <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
        <label style="font-size: 13px;">End Value:</label>
        <input type="number" id="modRangeEndVal" step="0.1" value="2.0" style="background: #2d2d2d; color: #e0e0e0; border: 1px solid #444; padding: 4px; border-radius: 4px;">
      </div>
    </div>
    <div style="margin-bottom: 16px; display: flex; gap: 8px; align-items: center;">
      <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
        <label style="font-size: 13px;">Curve (Easing):</label>
        <select id="modRangeCurve" style="background: #2d2d2d; color: #e0e0e0; border: 1px solid #444; padding: 4px; border-radius: 4px;">
          <option value="linear">Linear</option>
          <option value="easeIn">Ease-In</option>
          <option value="easeOut">Ease-Out</option>
          <option value="easeInOut">Ease-InOut</option>
        </select>
      </div>
      <div style="width: 70px; display: flex; flex-direction: column; gap: 4px;">
        <label style="font-size: 13px;">Strength:</label>
        <input type="number" id="modRangeStrength" step="0.5" value="2.0" min="0.5" max="10.0" style="background: #2d2d2d; color: #e0e0e0; border: 1px solid #444; padding: 4px; border-radius: 4px;">
      </div>
    </div>
    <div style="margin-bottom: 12px; display: flex; flex-direction: column; align-items: center;">
      <canvas id="curvePreviewCanvas" width="248" height="60" style="background: #11111b; border: 1px solid #444; border-radius: 4px;"></canvas>
    </div>
    <div style="display: flex; justify-content: flex-end; gap: 8px;">
      <button id="btnRangeCancel" style="background: #444;">Cancel</button>
      <button id="btnRangeAdd" style="background: #89b4fa; color: #121212; font-weight: bold;">Add</button>
    </div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
const notesOn   = ${JSON.stringify(notesOn)};
const notesOff  = ${JSON.stringify(notesOff)};
const effectMap = ${JSON.stringify(effectMap)};
const timingMap = ${JSON.stringify(timingMap)};
const mainBpm   = ${mainBpm};

const BASE_SPEED = 800;

// State
let currentMeasure = 0;

let useEffect = true;
let zoomPercent = 100;
let nodeStyle = 'Dot'; // 'Dot', 'Line', 'Hidden'
let gridDiv = 4;

let editMode = 'view'; // 'view', 'edit'

let isPlaying = false;
let playbackTimeMs = 0;
let lastFrameTime = 0;

// DOM
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const container = document.getElementById('container');
const lblMeasure = document.getElementById('lblMeasure');

// UI Listeners
document.getElementById('btnPrevMeasure').onclick = () => { currentMeasure = Math.max(0, Math.floor(currentMeasure) - 1); syncMsFromMeasure(); render(); };
document.getElementById('btnNextMeasure').onclick = () => { currentMeasure = Math.floor(currentMeasure) + 1; syncMsFromMeasure(); render(); };
document.getElementById('btnEffectOn').onclick = () => { useEffect = true; updateBtns(); render(); };
document.getElementById('btnEffectOff').onclick = () => { useEffect = false; updateBtns(); render(); };
document.getElementById('inpGrid').onchange = (e) => { 
  let val = parseInt(e.target.value);
  if (isNaN(val) || val < 1) val = 1;
  gridDiv = val;
  e.target.value = val;
  render(); 
};
document.getElementById('selMode').onchange = (e) => {
  editMode = e.target.value;
  canvas.style.cursor = editMode === 'view' ? 'default' : 'crosshair';
};

document.getElementById('btnNodeStyle').onclick = () => {
  if (nodeStyle === 'Dot') nodeStyle = 'Line';
  else if (nodeStyle === 'Line') nodeStyle = 'Hidden';
  else nodeStyle = 'Dot';
  const btn = document.getElementById('btnNodeStyle');
  btn.textContent = nodeStyle;
  btn.className = nodeStyle !== 'Hidden' ? 'active' : '';
  render();
};

// Playback UI
document.getElementById('btnPlay').onclick = () => { if(!isPlaying) { isPlaying = true; lastFrameTime = performance.now(); requestAnimationFrame(loop); } };
document.getElementById('btnPause').onclick = () => { isPlaying = false; };
document.getElementById('btnReset').onclick = () => { currentMeasure = 0; playbackTimeMs = 0; render(); };

window.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const zoomDelta = e.deltaY > 0 ? -10 : 10;
    zoomPercent += zoomDelta;
    if (zoomPercent < 10) zoomPercent = 10;
    if (zoomPercent > 1000) zoomPercent = 1000;
    render();
    return;
  }

  if (isPlaying) {
    isPlaying = false;
    updateBtns();
  }
  const scrollStep = 1 / gridDiv;
  currentMeasure += (e.deltaY > 0 ? -scrollStep : scrollStep);
  if (currentMeasure < 0) currentMeasure = 0;
  
  syncMsFromMeasure();
  render();
}, { passive: false });

let dragStartY = null;
let dragCurrentY = null;
let isDragging = false;
let pendingBeat = [0, 0, 1];
let pendingBeatRange = null; // { start, end }

function getYToSnappedBeatArr(screenY) {
  const J_LINE = canvas.height * 0.85;
  const zoom = zoomPercent / 100;
  const basePxPerBeat = (BASE_SPEED * zoom) * (60 / mainBpm);
  const viewCenterChartY = getChartPos(currentMeasure);
  
  const targetChartY = viewCenterChartY + (J_LINE - screenY) / basePxPerBeat;
  const targetBeatF = getBeatFFromChartY(targetChartY);
  
  const step = 1 / gridDiv;
  const snappedBeatF = Math.round(targetBeatF / step) * step;
  if (snappedBeatF < 0) return null;
  
  const measure = Math.floor(snappedBeatF);
  const remainderBeat = snappedBeatF - measure;
  let idx = Math.round(remainderBeat * gridDiv);
  if (idx === gridDiv) { idx = 0; return [measure + 1, 0, 1]; }
  
  function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
  const g = gcd(idx, gridDiv);
  let arr = [measure, idx / g, gridDiv / g];
  if (arr[1] === 0) arr[2] = 1;
  return arr;
}

function beatArrToF(arr) {
  return arr[0] + (arr[1] / arr[2]);
}

canvas.addEventListener('mousedown', (e) => {
  if (editMode === 'view' || e.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  dragStartY = e.clientY - rect.top;
  dragCurrentY = dragStartY;
  isDragging = false;
});

window.addEventListener('mousemove', (e) => {
  if (dragStartY !== null) {
    const rect = canvas.getBoundingClientRect();
    dragCurrentY = e.clientY - rect.top;
    if (Math.abs(dragCurrentY - dragStartY) > 5) {
      isDragging = true;
    }
    render(); // draw selection box
  }
});

window.addEventListener('mouseup', (e) => {
  if (dragStartY === null) return;
  const rect = canvas.getBoundingClientRect();
  dragCurrentY = e.clientY - rect.top;
  
  if (isDragging) {
    let b1 = getYToSnappedBeatArr(dragStartY);
    let b2 = getYToSnappedBeatArr(dragCurrentY);
    if (b1 && b2) {
      let f1 = beatArrToF(b1);
      let f2 = beatArrToF(b2);
      if (f1 > f2) {
        // Swap to make start < end
        let temp = b1; b1 = b2; b2 = temp;
      }
      if (beatArrToF(b1) !== beatArrToF(b2)) {
        pendingBeatRange = { start: b1, end: b2 };
        document.getElementById('modRangeStartBeat').textContent = JSON.stringify(b1);
        document.getElementById('modRangeEndBeat').textContent = JSON.stringify(b2);
        
        // Countのデフォルト値をドラッグしたグリッドの数に設定
        const f1 = beatArrToF(b1);
        const f2 = beatArrToF(b2);
        const defaultSteps = Math.max(1, Math.round((f2 - f1) / (1 / gridDiv)));
        document.getElementById('modRangeCount').value = defaultSteps;

        document.getElementById('rangeEffectModal').style.display = 'block';
        drawCurvePreview();
      }
    }
  } else {
    let b = getYToSnappedBeatArr(dragStartY);
    if (b) {
      pendingBeat = b;
      document.getElementById('modBeatDisplay').textContent = JSON.stringify(b);
      document.getElementById('effectModal').style.display = 'block';
    }
  }
  
  dragStartY = null;
  dragCurrentY = null;
  isDragging = false;
  render();
});

document.getElementById('btnModalCancel').onclick = () => {
  document.getElementById('effectModal').style.display = 'none';
};
document.getElementById('btnModalAdd').onclick = () => {
  const type = document.getElementById('modType').value;
  const valStr = document.getElementById('modValue').value;
  const val = parseFloat(valStr);
  if (!isNaN(val)) {
    vscode.postMessage({
      command: 'addEffect',
      beat: pendingBeat,
      type: type,
      value: val
    });
  }
  document.getElementById('effectModal').style.display = 'none';
};

document.getElementById('btnRangeCancel').onclick = () => {
  document.getElementById('rangeEffectModal').style.display = 'none';
};
document.getElementById('btnRangeAdd').onclick = () => {
  const type = document.getElementById('modRangeType').value;
  const startVal = parseFloat(document.getElementById('modRangeStartVal').value);
  const endVal = parseFloat(document.getElementById('modRangeEndVal').value);
  const curve = document.getElementById('modRangeCurve').value;
  let strength = parseFloat(document.getElementById('modRangeStrength').value);
  if (isNaN(strength) || strength <= 0) strength = 2.0;
  let count = parseInt(document.getElementById('modRangeCount').value);
  if (isNaN(count) || count < 1) count = 1;
  
  if (!isNaN(startVal) && !isNaN(endVal) && pendingBeatRange) {
    vscode.postMessage({
      command: 'addRangeEffect',
      startBeat: pendingBeatRange.start,
      endBeat: pendingBeatRange.end,
      type: type,
      startVal: startVal,
      endVal: endVal,
      curve: curve,
      strength: strength,
      count: count
    });
  }
  document.getElementById('rangeEffectModal').style.display = 'none';
};

document.getElementById('modRangeStartVal').addEventListener('input', drawCurvePreview);
document.getElementById('modRangeEndVal').addEventListener('input', drawCurvePreview);
document.getElementById('modRangeCurve').addEventListener('change', drawCurvePreview);
document.getElementById('modRangeStrength').addEventListener('input', drawCurvePreview);

function drawCurvePreview() {
  const cvs = document.getElementById('curvePreviewCanvas');
  const cctx = cvs.getContext('2d');
  cctx.clearRect(0, 0, cvs.width, cvs.height);

  const startVal = parseFloat(document.getElementById('modRangeStartVal').value) || 0;
  const endVal = parseFloat(document.getElementById('modRangeEndVal').value) || 0;
  const curve = document.getElementById('modRangeCurve').value;
  let strength = parseFloat(document.getElementById('modRangeStrength').value);
  if (isNaN(strength) || strength <= 0) strength = 2.0;

  const pX = 10, pY = 10;
  const w = cvs.width - pX * 2;
  const h = cvs.height - pY * 2;
  
  cctx.strokeStyle = '#313244';
  cctx.lineWidth = 1;
  cctx.strokeRect(pX, pY, w, h);
  
  const minVal = Math.min(startVal, endVal) - Math.abs(endVal - startVal) * 0.2;
  const maxVal = Math.max(startVal, endVal) + Math.abs(endVal - startVal) * 0.2;
  const range = (maxVal - minVal) === 0 ? 1 : (maxVal - minVal);
  
  const getY = (v) => pY + h - ((v - minVal) / range) * h;
  
  cctx.strokeStyle = '#89b4fa';
  cctx.lineWidth = 2;
  cctx.lineJoin = 'round';
  cctx.beginPath();
  
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let easedT = t;
    if (curve === 'easeIn') easedT = Math.pow(t, strength);
    else if (curve === 'easeOut') easedT = 1 - Math.pow(1 - t, strength);
    else if (curve === 'easeInOut') {
        easedT = t < 0.5 ? Math.pow(2, strength - 1) * Math.pow(t, strength) : 1 - Math.pow(-2 * t + 2, strength) / 2;
    }
    
    const val = startVal + (endVal - startVal) * easedT;
    const px = pX + t * w;
    const py = getY(val);
    
    if (i === 0) cctx.moveTo(px, py);
    else cctx.lineTo(px, py);
  }
  cctx.stroke();

  cctx.fillStyle = '#f38ba8';
  cctx.beginPath(); cctx.arc(pX, getY(startVal), 3, 0, Math.PI*2); cctx.fill();
  cctx.beginPath(); cctx.arc(pX + w, getY(endVal), 3, 0, Math.PI*2); cctx.fill();
}

function updateBtns() {
  document.getElementById('btnEffectOn').className = useEffect ? 'active' : '';
  document.getElementById('btnEffectOff').className = !useEffect ? 'active' : '';
}

// Resize
function resize() {
  canvas.width = Math.min(600, container.clientWidth - 20);
  canvas.height = container.clientHeight;
  render();
}
window.onresize = resize;

// Engine logic for viewCenter computation
function getBpmAt(beatF) {
  let bpm = 120;
  for (const ev of timingMap) {
    if (ev.beatF <= beatF + 1e-9) bpm = ev.bpm;
    else break;
  }
  return bpm;
}
function getChartPos(targetBeatF) {
  if (!useEffect) return targetBeatF;
  let pos = 0;
  let currentScroll = 1.0;
  let prevBeatF = 0;
  for (const ev of effectMap) {
    if (ev.beatF > targetBeatF + 1e-9) break;
    pos += currentScroll * (ev.beatF - prevBeatF);
    if (ev.jump !== undefined) {
      const bpm = getBpmAt(ev.beatF);
      pos += ev.jump * bpm / 60000;
    }
    if (ev.scroll !== undefined) {
      currentScroll = ev.scroll;
    }
    prevBeatF = ev.beatF;
  }
  pos += currentScroll * (targetBeatF - prevBeatF);
  return pos;
}

function getBeatFFromChartY(targetY) {
  if (!useEffect) return targetY;
  let low = 0;
  let high = Math.max(currentMeasure + 100, 1000);
  for (let i = 0; i < 50; i++) {
    let mid = (low + high) / 2;
    let midY = getChartPos(mid);
    if (midY < targetY) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

function beatFToMs(beatF) {
  let ms = 0;
  for (let i = 0; i < timingMap.length; i++) {
    const ev = timingMap[i];
    const nextBeat = (i + 1 < timingMap.length) ? timingMap[i+1].beatF : Infinity;
    if (beatF <= nextBeat) {
      ms = ev.ms + (beatF - ev.beatF) * (60000 / ev.bpm);
      break;
    }
  }
  return ms;
}

function msToBeatF(ms) {
  if (timingMap.length === 0) return ms * (120 / 60000);
  let ev = timingMap[0];
  for (let i = timingMap.length - 1; i >= 0; i--) {
    if (timingMap[i].ms <= ms) {
      ev = timingMap[i];
      break;
    }
  }
  return ev.beatF + (ms - ev.ms) / 1000 * (ev.bpm / 60);
}

function syncMsFromMeasure() {
  playbackTimeMs = beatFToMs(currentMeasure);
}

function loop(timestamp) {
  if (!isPlaying) return;
  const delta = timestamp - lastFrameTime;
  lastFrameTime = timestamp;
  
  playbackTimeMs += delta;
  currentMeasure = msToBeatF(playbackTimeMs);
  
  render();
  requestAnimationFrame(loop);
}

function getJudgementLineY() {
  return canvas.height * 0.85;
}

function render() {
  lblMeasure.textContent = Math.floor(currentMeasure).toString();
  
  const zoom = zoomPercent / 100;
  const basePxPerBeat = (BASE_SPEED * zoom) * (60 / mainBpm);
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  const notes = useEffect ? notesOn : notesOff;
  const viewCenterBeatF = currentMeasure;
  const viewCenterChartY = getChartPos(viewCenterBeatF);
  
  const J_LINE = getJudgementLineY();
  
  
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';

  ctx.lineWidth = 1;
  const V_LINES = 8;
  for (let i = 1; i < V_LINES; i++) {
    const vx = (i / V_LINES) * canvas.width;
    ctx.beginPath();
    ctx.moveTo(vx, 0);
    ctx.lineTo(vx, canvas.height);
    ctx.stroke();
  }

  ctx.font = '10px Arial';
  
  const step = 1 / gridDiv;

  const startBeat = Math.max(0, currentMeasure - 5);
  const endBeat   = currentMeasure + 15;
  const startStep = Math.floor(startBeat / step);
  const endStep   = Math.ceil(endBeat / step);
  
  function gcd(a, b) {
    return b === 0 ? a : gcd(b, a % b);
  }

  for (let i = startStep; i <= endStep; i++) {
    const b = i * step;
    const mChartY = getChartPos(b);
    const screenY = J_LINE - (mChartY - viewCenterChartY) * basePxPerBeat;
    
    if (screenY < -50 || screenY > canvas.height + 50) continue;
    
    let idx = i % gridDiv;
    if (idx < 0) idx += gridDiv;
    
    const g = gcd(idx, gridDiv);
    const q = gridDiv / g;

    
    let color = 'rgba(150, 150, 150, 0.7)';

    let isMeasure = false;

    if (q === 1) {
      color = 'rgba(255, 255, 255, 0.9)';

      isMeasure = true;
    } else if (q === 2) {
      color = 'rgba(100, 200, 255, 0.8)';

    } else if (q === 3) {
      color = 'rgba(200, 100, 255, 0.8)';

    } else if (q === 4) {
      color = 'rgba(255, 100, 255, 0.8)';

    } else if (q === 5) {
      color = 'rgba(100, 255, 150, 0.8)';

    } else if (q === 6) {
      color = 'rgba(255, 255, 100, 0.8)';

    } else if (q === 8) {
      color = 'rgba(255, 150, 100, 0.8)';

    } else if (q === 12 || q === 16) {
      color = 'rgba(200, 200, 200, 0.6)';

    }
    
    ctx.strokeStyle = color;
    ctx.lineWidth = isMeasure ? 2 : 1;

    ctx.beginPath();
    ctx.moveTo(0, screenY);
    ctx.lineTo(canvas.width, screenY);
    ctx.stroke();
    
    if (isMeasure) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      const mIdx = Math.floor((b + 0.001) / 4);
      ctx.fillText(mIdx.toString(), 5, screenY - 2);
    }
  }

  ctx.strokeStyle = '#f38ba8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, J_LINE);
  ctx.lineTo(canvas.width, J_LINE);
  ctx.stroke();

  const W = canvas.width;
  
  ctx.fillStyle = 'rgba(137, 180, 250, 0.4)';
  for (const n of notes) {
    if (n.segPath && n.segPath.length > 0) {
      let prevY = J_LINE - (n.chartY - viewCenterChartY) * basePxPerBeat;
      let prevX = n.x * W;

      let prevHalfW = (n.w * W) / 2;
      
      for (const pt of n.segPath) {
        const ptY = J_LINE - (pt.y - viewCenterChartY) * basePxPerBeat;
        const ptX = pt.x * W;

        const ptHalfW = (pt.w * W) / 2;
        
        ctx.beginPath();
        ctx.moveTo(prevX - prevHalfW, prevY);
        ctx.lineTo(prevX + prevHalfW, prevY);
        ctx.lineTo(ptX + ptHalfW, ptY);
        ctx.lineTo(ptX - ptHalfW, ptY);
        ctx.closePath();
        ctx.fill();
        
        prevX = ptX;
        prevY = ptY;
        prevHalfW = ptHalfW;
      }
    }
  }
  
  for (const n of notes) {
    const screenY = J_LINE - (n.chartY - viewCenterChartY) * basePxPerBeat;
    
    if (screenY < -1000 || screenY > canvas.height + 1000) continue;
    
    const nx = n.x * W;

    const nw = n.w * W;
    const nh = 10;
    const halfW = nw / 2;
    
    ctx.fillStyle = n.isHold ? '#f9e2af' : '#89b4fa';
    ctx.fillRect(nx - halfW, screenY - nh/2, nw, nh);
    ctx.strokeStyle = '#1e1e2e';
    ctx.lineWidth = 1;
    ctx.strokeRect(nx - halfW, screenY - nh/2, nw, nh);

    if (n.segPath && nodeStyle !== 'Hidden') {
      for (const pt of n.segPath) {
        const ptY = J_LINE - (pt.y - viewCenterChartY) * basePxPerBeat;
        if (ptY < -1000 || ptY > canvas.height + 1000) continue;
        
        const ptNx = pt.x * W;

        const ptNw = pt.w * W;
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        
        if (nodeStyle === 'Line') {
          const ptNh = 4;

          ctx.fillRect(ptNx - ptNw/2, ptY - ptNh/2, ptNw, ptNh);
        } else if (nodeStyle === 'Dot') {
          ctx.beginPath();
          ctx.arc(ptNx, ptY, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

  if (dragStartY !== null && isDragging) {
    const rectTop = Math.min(dragStartY, dragCurrentY);
    const rectHeight = Math.abs(dragCurrentY - dragStartY);
    ctx.fillStyle = 'rgba(137, 180, 250, 0.2)';
    ctx.fillRect(0, rectTop, canvas.width, rectHeight);
    ctx.strokeStyle = '#89b4fa';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, rectTop, canvas.width, rectHeight);
  }
}

window.addEventListener('resize', resize);
resize();
syncMsFromMeasure();
</script>
</body>
</html>`;
}
