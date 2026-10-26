import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Feedback, type FeedbackTone } from '../components/feedback.js';
import { connectTerminal } from './terminal-connection.js';
import '@xterm/xterm/css/xterm.css';

export function TerminalApp({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('');
  const [cwd, setCwd] = useState('');
  const [ended, setEnded] = useState(false);
  const [hasOutput, setHasOutput] = useState(false);
  const [tone, setTone] = useState<FeedbackTone>('neutral');
  useEffect(() => {
    if (!host.current) return;
    setEnded(false);
    setStatus('');
    setHasOutput(false);
    setTone('neutral');
    let outputSeen = false;
    const style = getComputedStyle(host.current);
    const scrollThumb = style.getPropertyValue('--scrollbar-thumb').trim();
    const scrollHover = style.getPropertyValue('--scrollbar-thumb-hover').trim();
    const terminal = new Terminal({
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      screenReaderMode: true,
      overviewRuler: { width: parseFloat(style.getPropertyValue('--scrollbar-size')), showTopBorder: false, showBottomBorder: false },
      theme: {
        background: '#ffffff',
        foreground: '#292a2e',
        cursor: '#3b7ef5',
        selectionBackground: '#dce8ff',
        scrollbarSliderBackground: scrollThumb,
        scrollbarSliderHoverBackground: scrollHover,
        scrollbarSliderActiveBackground: scrollHover,
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    let ready = false;
    let finished = false;
    let disposed = false;
    let resizeTimer: number | null = null;
    let sentCols = 0;
    let sentRows = 0;
    const resize = () => {
      if (disposed || !host.current?.clientWidth || !host.current.clientHeight) return;
      // Drain queued output before changing the parser's screen dimensions.
      terminal.write('', () => {
        if (disposed || !host.current?.clientWidth || !host.current.clientHeight) return;
        fit.fit();
        if (ready && (terminal.cols !== sentCols || terminal.rows !== sentRows)) {
          sentCols = terminal.cols;
          sentRows = terminal.rows;
          connection.send({ type: 'resize', cols: sentCols, rows: sentRows });
        }
      });
    };
    const scheduleResize = () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      // A moving panel can cross many character sizes; ConPTY redraws once at rest.
      resizeTimer = window.setTimeout(resize, 80);
    };
    const connection = connectTerminal(
      sessionId,
      (message) => {
        if (message.type === 'output') {
          terminal.write(message.data);
          if (!outputSeen && message.data) {
            outputSeen = true;
            setHasOutput(true);
          }
        }
        if (message.type === 'ready') {
          if (message.windowsPty) terminal.options.windowsPty = message.windowsPty;
          ready = true;
          setStatus('');
          setCwd(message.cwd);
          resize();
          terminal.focus();
        }
        if (message.type === 'error' || message.type === 'exit') {
          finished = true;
          setStatus(message.type === 'error' ? message.message : `Shell exited (${message.code})`);
          setTone(message.type === 'error' ? 'error' : message.code === 0 ? 'neutral' : 'warning');
          setEnded(true);
        }
      },
      () => {
        ready = false;
        if (!finished) {
          setStatus('Terminal disconnected.');
          setTone('warning');
        }
        setEnded(true);
      },
    );
    const input = terminal.onData((data) => connection.send({ type: 'input', data }));
    const size = new ResizeObserver(scheduleResize);
    size.observe(host.current);
    // Terminal shortcuts (especially Escape) must not reach chat run controls.
    const stopKey = (event: KeyboardEvent) => event.stopPropagation();
    const element = host.current;
    element.addEventListener('keydown', stopKey);
    return () => {
      disposed = true;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      element.removeEventListener('keydown', stopKey);
      size.disconnect();
      input.dispose();
      connection.dispose();
      terminal.dispose();
    };
  }, [sessionId, attempt]);
  return (
    <div className="terminal-app" title={cwd}>
      <div className="terminal-screen" ref={host} hidden={ended && !hasOutput} />
      {status ? (
        <Feedback
          tone={tone}
          layout={ended && !hasOutput ? 'state' : 'inline'}
          title={hasOutput ? undefined : 'Terminal unavailable'}
          action={ended ? { label: 'New terminal', onClick: () => setAttempt((value) => value + 1) } : undefined}
        >
          {status}
        </Feedback>
      ) : null}
    </div>
  );
}
