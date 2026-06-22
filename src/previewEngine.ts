/**
 * previewEngine.ts
 *
 * 譜面プレビュー用の計算エンジン。
 * vscode に一切依存しないため Node.js 単体でテスト可能。
 */


/** .mc ファイルの beat 配列 [小節, 分子, 分母] を実数（拍単位）に変換する */
export function beatToFloat(beat: [number, number, number]): number {
    const [measure, num, den] = beat;
    return measure + (den === 0 ? 0 : num / den);
}


export interface TimingEvent {
    beatF: number;

    bpm:   number;

    ms:    number;

}

/**
 * .mc の `time` 配列から TimingEvent 列を構築する。
 * 結果は beatF 昇順にソートされる。
 *
 * time エントリ例: { beat:[0,0,1], bpm:180 }
 */
export function buildTimingMap(timeArr: any[]): TimingEvent[] {
    const events: TimingEvent[] = timeArr
        .filter(t => t.bpm !== undefined)
        .map(t => ({ beatF: beatToFloat(t.beat), bpm: t.bpm, ms: 0 }))
        .sort((a, b) => a.beatF - b.beatF);

    let accMs = 0;
    for (let i = 0; i < events.length; i++) {
        events[i].ms = accMs;
        if (i + 1 < events.length) {
            const deltaBeat = events[i + 1].beatF - events[i].beatF;
            accMs += deltaBeat * (60000 / events[i].bpm);
        }
    }
    return events;
}

/** 任意の beatF に対応する BPM を返す */
export function getBpmAt(beatF: number, timingMap: TimingEvent[]): number {
    let bpm = 120;

    for (const ev of timingMap) {
        if (ev.beatF <= beatF + 1e-9) bpm = ev.bpm;
        else break;
    }
    return bpm;
}

/** 譜面の最後のノーツ位置を取得する */
export function getLastBeatF(noteArr: any[]): number {
    if (!noteArr || noteArr.length === 0) return 0;
    let maxBeat = 0;
    for (const n of noteArr) {
        const b = beatToFloat(n.beat);
        if (b > maxBeat) maxBeat = b;
    }
    return maxBeat;
}

/**
 * 曲中で「最も長い時間使われている BPM」を算出する。
 * 各 TimingEvent の区間を実時間(ms)に換算し、最長のBPMをメインとする。
 */
export function calculateMainBpm(timingMap: TimingEvent[], lastBeatF: number): number {
    if (!timingMap || timingMap.length === 0) return 120;
    
    const durations = new Map<number, number>();
    for (let i = 0; i < timingMap.length; i++) {
        const startBeat = timingMap[i].beatF;
        let endBeat = (i + 1 < timingMap.length) ? timingMap[i + 1].beatF : lastBeatF;
        if (endBeat < startBeat) endBeat = startBeat;
        
        const bpm = timingMap[i].bpm;
        const durationMs = (endBeat - startBeat) * (60000 / bpm);
        
        durations.set(bpm, (durations.get(bpm) ?? 0) + durationMs);
    }
    
    let mainBpm = 120;
    let maxDuration = -1;
    for (const [bpm, dur] of durations.entries()) {
        if (dur > maxDuration) {
            maxDuration = dur;
            mainBpm = bpm;
        }
    }
    return mainBpm;
}


export interface EffectEvent {
    beatF:   number;
    scroll?: number;

    jump?:   number;

}

/**
 * .mc の `effect` 配列から EffectEvent 列を構築する。
 * beatF 昇順にソートされる。
 */
export function buildEffectMap(effectArr: any[]): EffectEvent[] {
    return (effectArr ?? [])
        .map((e: any) => ({
            beatF:  beatToFloat(e.beat),
            scroll: e.scroll,
            jump:   e.jump,
        }))
        .sort((a, b) => a.beatF - b.beatF);
}

/**
 * 任意の beatF における chart_pos（仮想位置）を返す。
 *
 * chart_pos は「scroll 値で重み付けた拍数の積分 + jump オフセット」。
 * effect OFF の場合は単純に beatF を返す。
 *
 * @param targetBeatF  計算したい拍位置
 * @param effectMap    buildEffectMap() で構築したイベント列
 * @param timingMap    buildTimingMap() で構築したタイミング列（jump 換算に使用）
 * @param useEffect    false の場合は targetBeatF をそのまま返す
 */
export function getChartPos(
    targetBeatF: number,
    effectMap:   EffectEvent[],
    timingMap:   TimingEvent[],
    useEffect:   boolean,
): number {
    if (!useEffect) return targetBeatF;

    let pos          = 0;
    let currentScroll = 1.0;
    let prevBeatF    = 0;


    for (const ev of effectMap) {
        if (ev.beatF > targetBeatF + 1e-9) break;

        pos += currentScroll * (ev.beatF - prevBeatF);

        //    jump_ms × (BPM / 60 / 1000) = jump_ms × BPM / 60000
        if (ev.jump !== undefined) {
            const bpm = getBpmAt(ev.beatF, timingMap);
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


export interface SegPoint {
    x: number;

    y: number;

    w: number;

}

export interface NoteRenderInfo {
    beatF:   number;

    x:       number;

    w:       number;

    chartY:  number;

    isHold:  boolean;

    isBgm:   boolean;

    segPath: SegPoint[];

}

const NOTE_X_MAX = 256;


/**
 * ノーツ1件の描画情報を計算する。
 *
 * @param note         .mc の note エントリ
 * @param effectMap    buildEffectMap() で構築したイベント列
 * @param timingMap    buildTimingMap() で構築したタイミング列
 * @param useEffect    effect を適用するか
 */
export function calcNoteRenderInfo(
    note:       any,
    effectMap:  EffectEvent[],
    timingMap:  TimingEvent[],
    useEffect:  boolean,
): NoteRenderInfo {
    const beatF  = beatToFloat(note.beat);
    const chartY = getChartPos(beatF, effectMap, timingMap, useEffect);

    const segPath: SegPoint[] = [];
    if (note.seg) {
        let currentW = note.w ?? 32;
        for (const seg of note.seg) {
            const relBeatF    = beatToFloat(seg.beat);
            const absBeatF    = beatF + relBeatF;
            const segChartY   = getChartPos(absBeatF, effectMap, timingMap, useEffect);
            const absX        = ((note.x ?? 0) + (seg.x ?? 0)) / NOTE_X_MAX;
            if (seg.w !== undefined) currentW = seg.w;
            segPath.push({ x: absX, y: segChartY, w: currentW / NOTE_X_MAX });
        }
    }

    return {
        beatF,
        x:       (note.x ?? 0) / NOTE_X_MAX,
        w:       (note.w ?? 32) / NOTE_X_MAX,
        chartY,
        isHold:  note.type === 4,
        isBgm:   note.type === 1,
        segPath,
    };
}

/**
 * 譜面全体のノーツ描画情報を一括計算する。
 * type=1（BGM）は除外して返す。
 */
export function calcAllNoteRenderInfos(
    noteArr:   any[],
    effectMap: EffectEvent[],
    timingMap: TimingEvent[],
    useEffect: boolean,
): NoteRenderInfo[] {
    return noteArr
        .map(n => calcNoteRenderInfo(n, effectMap, timingMap, useEffect))
        .filter(n => !n.isBgm);
}
