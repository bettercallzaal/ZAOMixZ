// Clock.js — a tick that keeps going when the DJ clicks away from the tab.
//
// Chrome stops requestAnimationFrame in a hidden tab and slows setInterval to once a second
// (once a minute after five quiet minutes). A mix driven by either froze mid-blend while the
// DJ was in another tab: the next song sat at zero volume until they came back. Timers in a
// worker are not slowed that way, so the tick comes from a tiny worker, and from setInterval
// where a worker cannot start.
//
// every(ms, fn) returns stop(). Runs under node with a stand-in Worker: see Clock.test.mjs.

const SOURCE = 'let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data);};';

export function every(ms, fn, env = globalThis) {
    let worker = null;
    let timer = null;
    let url = null;
    try {
        if (typeof env.Worker === 'function' && env.URL?.createObjectURL && typeof env.Blob === 'function') {
            url = env.URL.createObjectURL(new env.Blob([SOURCE], { type: 'text/javascript' }));
            worker = new env.Worker(url);
            worker.onmessage = () => { try { fn(); } catch (e) { console.warn('[Clock] tick failed:', e); } };
            worker.onerror = () => { stopWorker(); timer = env.setInterval(fn, ms); };
            worker.postMessage(ms);
        }
    } catch (e) {
        worker = null;
    }
    function stopWorker() {
        if (!worker) return;
        try { worker.postMessage(0); worker.terminate(); } catch (e) { /* gone */ }
        try { if (url) env.URL.revokeObjectURL(url); } catch (e) { /* gone */ }
        worker = null;
    }
    if (!worker) timer = env.setInterval(fn, ms);
    return () => { stopWorker(); if (timer != null) env.clearInterval(timer); timer = null; };
}
