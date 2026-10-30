import { toolEntryCommand, toolEntryDetails } from '../tool-display.js';
import { dividerLabel } from '../divider-label.js';
import { Transform } from 'node:stream';
import { Box, measureElement, render, Text, useApp, useBoxMetrics, useInput, usePaste, useWindowSize, type DOMElement } from 'ink';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { renderMermaidASCII } from 'beautiful-mermaid';
import { Marked, type Token, type Tokens } from 'marked';
import stringWidth from 'string-width';
import { readClipboardImageBase64 } from '../clipboard-image.js';
import { writeClipboardText } from '../clipboard-text.js';
import { FrameSelectionTracker, decorate } from './frame-selection.js';
import { mergeMarkdownTokenSegments } from './markdown-merge.js';
import { displayFilePath, parseHref } from '../web/link-protocol.js';
import type { ApprovalDecision } from '../agent-session.js';
import type { AgentSessionClient } from '../agent-session.js';
import { getCatalogIndex, getProvider, listProviderSummaries } from '../provider/catalog.js';
import { resolveModelName } from '../provider/model-presentation.js';
import { listSupportedPackages, listCatalogModels, providerIsConfigured, resolveReasoningVariant } from '../provider/registry.js';
import { loadSettings, rememberProviderModel } from '../settings.js';
import { listSavedSessions, type SessionEntry, type SessionSummary, type NoticeTone } from '../session-store.js';
import { upsertProvider, writeSettings } from './config-edit.js';
import { getOpenButlerVersion } from '../version.js';
import { detectTerminalTheme } from './terminal-detect.js';
import { glyphs, uiTokens, type ResolvedTheme, type UiTheme, type UiTokens } from './theme.js';

type Entry = SessionEntry;

type SessionChoice = { kind: 'new' } | { kind: 'saved'; session: SessionSummary };
type ProviderChoice = { kind: 'catalog' | 'custom' | 'add-custom'; id: string; name: string; modelCount: number };
type ModelChoice = { providerId: string; modelId: string; name?: string };
type ClipboardImage = { base64: string; mediaType: 'image/png' };
const MAX_PASTED_TEXT_BYTES = 5 * 1024;
const MAX_CLIPBOARD_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_ONLY_PROMPT = 'User attached image';
const COMPOSER_SLOT_HEIGHT = 3;
const approvalActions: Array<{ label: string; decision: ApprovalDecision }> = [
  { label: 'Allow once', decision: 'allow' },
  { label: 'Deny', decision: 'deny' },
  { label: 'Always allow', decision: 'always' },
];

const slashCommands = [
  { command: '/help', description: 'Show available commands' },
  { command: '/clear', description: 'Clear this session' },
  { command: '/settings', description: 'Open settings' },
  { command: '/permissions', description: 'Choose workspace, auto-review, or full-access mode' },
  { command: '/reasoning', description: 'Choose model reasoning' },
  { command: '/thinking', description: 'Show or hide reasoning text' },
  { command: '/compact', description: 'Summarize the complete model context' },
  { command: '/stop', description: 'Stop the current run and keep queued messages' },
  { command: '/models', description: 'Choose a model from configured providers' },
  { command: '/provider', description: 'Add a provider, API key, and model' },
  { command: '/session', description: 'Search and open a saved session' },
  { command: '/skills', description: 'List available global and workspace skills' },
  { command: '/exit', description: 'Close this terminal UI; the background host keeps running' },
];

const themeOptions = ['Dark', 'Light', 'System'];
const markdownParser = new Marked({ gfm: true, breaks: true });

type MouseInputBridge = {
  stdin: NodeJS.ReadableStream;
  supported: boolean;
  setMouseHandler: (handler: ((event: MouseInputEvent) => void) | null) => void;
  close: () => void;
};

type MouseInputEvent = {
  kind: 'press' | 'drag' | 'release' | 'wheel-up' | 'wheel-down';
  x: number;
  y: number;
};

export async function runTerminalSession(controller: AgentSessionClient): Promise<void> {
  const mouseInput = createMouseInputBridge();
  const selection = new FrameSelectionTracker();
  try {
    const initialTheme = loadInitialTheme();
    const systemTheme = initialTheme === 'System' ? ((await detectTerminalTheme()) ?? 'dark') : 'dark';
    const app = render(
      <SessionScreen
        controller={controller}
        mouseInput={mouseInput}
        selection={selection}
        initialTheme={initialTheme}
        systemTheme={systemTheme}
      />,
      {
        alternateScreen: true,
        // Only changed lines are written back; the frame Ink computes does not
        // change, so the screen looks the same with less terminal traffic.
        incrementalRendering: true,
        exitOnCtrlC: false,
        stdin: mouseInput.stdin,
        stdout: createSelectionStdout(selection),
      },
    );
    await app.waitUntilExit();
  } finally {
    mouseInput.close();
  }
}

function loadInitialTheme(): UiTheme {
  try {
    return loadSettings().theme ?? 'Dark';
  } catch {
    return 'Dark';
  }
}

/**
 * Frames written by Ink pass through the selection tracker, which highlights
 * the current selection before the bytes reach the terminal. Ink keeps the real
 * stream's other capabilities (resize events, dimensions) through the proxy.
 */
function createSelectionStdout(selection: FrameSelectionTracker): NodeJS.WriteStream {
  const stdout = process.stdout;
  return new Proxy(stdout, {
    get(target, property) {
      if (property === 'write') {
        return (chunk: string | Uint8Array, encoding?: unknown) => {
          const text =
            typeof chunk === 'string'
              ? chunk
              : Buffer.from(chunk).toString(typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
          if (!text.includes('\n')) return stdout.write(text);
          try {
            return stdout.write(selection.frame(text));
          } catch {
            return stdout.write(text);
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as NodeJS.WriteStream;
}

export function createMouseInputBridge(
  source: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (enabled: boolean) => void } = process.stdin,
): MouseInputBridge {
  const rawInput = source;
  if (!rawInput.isTTY || typeof rawInput.setRawMode !== 'function' || !process.stdout.isTTY) {
    return {
      stdin: rawInput,
      supported: false,
      setMouseHandler: () => {},
      close: () => {},
    };
  }

  let handler: ((event: MouseInputEvent) => void) | null = null;
  let pendingInput = '';
  const input = new Transform({
    transform(chunk, _encoding, callback) {
      pendingInput += chunk.toString('utf8');
      const mouseSequence = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
      let match: RegExpExecArray | null;
      let consumed = 0;
      while ((match = mouseSequence.exec(pendingInput)) !== null) {
        consumed = mouseSequence.lastIndex;
        const button = Number(match[1]);
        const released = match[4] === 'm';
        const event = { x: Number(match[2]) - 1, y: Number(match[3]) - 1 };
        if ((button & 64) !== 0) {
          handler?.({ ...event, kind: (button & 1) === 0 ? 'wheel-up' : 'wheel-down' });
        } else if (released) {
          if ((button & 3) === 0) handler?.({ ...event, kind: 'release' });
        } else if ((button & 32) !== 0) {
          if ((button & 3) === 0) handler?.({ ...event, kind: 'drag' });
        } else if ((button & 3) === 0) {
          handler?.({ ...event, kind: 'press' });
        }
      }
      pendingInput = consumed > 0 ? pendingInput.slice(consumed) : pendingInput.slice(-64);
      callback(null, chunk);
    },
  }) as Transform & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
  Object.defineProperty(input, 'isTTY', { value: true });
  input.setRawMode = (enabled) => rawInput.setRawMode!(enabled);
  rawInput.pipe(input);

  return {
    stdin: input,
    supported: true,
    setMouseHandler: (nextHandler) => {
      handler = nextHandler;
    },
    close: () => {
      rawInput.unpipe(input);
      input.end();
    },
  };
}

const RUNNING_WORD = 'running';

/** A bright highlight that sweeps across "running", with a cycling spinner glyph. */
function RunningIndicator({ tokens }: { tokens: UiTokens }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    // Slow sweep: every tick rewrites the footer line, so a fast per-letter
    // sweep means constant terminal churn while a run is active.
    const timer = setInterval(() => setFrame((value) => (value + 1) % 1_000_000), 300);
    return () => clearInterval(timer);
  }, []);
  const spinner = glyphs.spinner[frame % glyphs.spinner.length]!;
  const highlight = frame % (RUNNING_WORD.length + 3);
  return (
    <Text>
      <Text color={tokens.accent} bold>
        {`${spinner} `}
      </Text>
      {Array.from(RUNNING_WORD, (character, index) => (
        <Text key={index} {...(index === highlight ? { color: tokens.accent, bold: true } : { dimColor: true })}>
          {character}
        </Text>
      ))}
    </Text>
  );
}

export function SessionScreen({
  controller: parentController,
  mouseInput,
  selection,
  initialTheme,
  systemTheme,
}: {
  controller: AgentSessionClient;
  mouseInput: MouseInputBridge;
  selection: FrameSelectionTracker;
  initialTheme: UiTheme;
  systemTheme: ResolvedTheme;
}) {
  const [subagentView, setSubagentView] = useState<AgentSessionClient | null>(null);
  const subagentClientRef = useRef<AgentSessionClient | null>(null);
  useEffect(
    () => () => {
      const client = subagentClientRef.current;
      subagentClientRef.current = null;
      if (client) void client.close();
    },
    [],
  );
  // While a subagent view is open the whole screen reads from that worker session
  // (view-only); the parent client keeps its own connection and snapshot in the
  // background, and the up arrow returns to it.
  const controller = subagentView ?? parentController;
  const runtime = controller.runtime;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const activeSession = snapshot.session;
  const entries = activeSession.entries;
  const pending = snapshot.pendingApproval;
  const pendingApprovalId = snapshot.pendingApprovalId;
  const pendingQuestion = snapshot.pendingQuestion;
  const pendingQuestionId = pendingQuestion?.id ?? null;
  const pendingQuestionOptions = pendingQuestion?.options ?? [];
  const busy = snapshot.busy;
  const queuedMessageCount = snapshot.queuedMessageCount;
  const queuedMessages = snapshot.queuedMessages ?? (snapshot.firstQueuedMessage ? [snapshot.firstQueuedMessage] : []);
  const sessionSaveError = snapshot.sessionSaveError;
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  // The transcript uses the whole width the terminal gives it. It used to stop
  // at 82 columns for a comfortable reading measure, which left the right half
  // of a wide terminal empty and made the transcript look cut off.
  const width = Math.max(24, columns - 4);
  const composerWidth = Math.max(1, columns - 4);
  const [approvalSelection, setApprovalSelection] = useState(0);
  const [questionSelection, setQuestionSelection] = useState(0);
  const [questionText, setQuestionText] = useState('');
  const [questionKey, setQuestionKey] = useState(0);
  const [expandedCommand, setExpandedCommand] = useState(false);
  const [approvalPanelHeight, setApprovalPanelHeight] = useState(8);
  const [expandedTools, setExpandedTools] = useState<Set<number>>(() => new Set());
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(() => new Set());
  const [expandedNotices, setExpandedNotices] = useState<Set<number>>(() => new Set());
  // Per-entry reasoning bodies: the global thinking setting decides the default,
  // and a click on one header flips that block either way.
  const [toggledReasoning, setToggledReasoning] = useState<Set<number>>(() => new Set());
  const [escapeWarning, setEscapeWarning] = useState<string | null>(null);
  const [composerKey, setComposerKey] = useState(0);
  const [composerText, setComposerText] = useState('');
  /** Submitted inputs, oldest first, for shell-style up/down recall in the composer. */
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [largePasteContent, setLargePasteContent] = useState('');
  const [imageAttachments, setImageAttachments] = useState<ClipboardImage[]>([]);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [permissionsSelection, setPermissionsSelection] = useState(
    runtime.approvalMode === 'full-access' ? 2 : runtime.approvalMode === 'auto-review' ? 1 : 0,
  );
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerPickerMode, setProviderPickerMode] = useState<'provider' | 'models'>('provider');
  const [sessionChooserOpen, setSessionChooserOpen] = useState(false);
  const [savedSessions, setSavedSessions] = useState<SessionSummary[]>([]);
  const [sessionSearch, setSessionSearch] = useState('');
  const [sessionSelection, setSessionSelection] = useState(0);
  const [selectedTheme, setSelectedTheme] = useState<UiTheme>(initialTheme);
  const [settingsSelection, setSettingsSelection] = useState(0);
  const [reasoningVariantId, setReasoningVariantId] = useState(
    () => resolveReasoningVariant(runtime.reasoningVariants, runtime.reasoningDefault).id,
  );
  const [reasoningSelection, setReasoningSelection] = useState(0);
  const [thinkingSelection, setThinkingSelection] = useState(runtime.showReasoningDefault ? 1 : 0);
  const [showReasoning, setShowReasoning] = useState(runtime.showReasoningDefault);
  const [requestedScrollTop, setRequestedScrollTop] = useState(Number.MAX_SAFE_INTEGER);
  const escapeStopArmed = useRef(false);
  const escapeStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showReasoningRef = useRef(showReasoning);
  showReasoningRef.current = showReasoning;
  const followTail = useRef(true);
  const viewportRef = useRef<DOMElement | null>(null);
  const composerSlotRef = useRef<DOMElement | null>(null);
  const approvalPanelRef = useRef<DOMElement | null>(null);
  const commandRef = useRef<DOMElement | null>(null);
  const approvalButtonRefs = useRef(new Map<ApprovalDecision, DOMElement>());
  const toolRefs = useRef(new Map<number, DOMElement>());
  const entryRefs = useRef(new Map<number, DOMElement>());
  const entryRefCallbacks = useRef(new Map<number, (element: DOMElement | null) => void>());
  const entryHeightCache = useRef(new WeakMap<Entry, Map<string, number>>());
  const measuredHeightCache = useRef(new WeakMap<Entry, Map<string, number>>());
  const transcriptRowCache = useRef(new WeakMap<Entry, { key: string; element: ReactNode }>());
  const getEntryRef = useCallback((index: number) => {
    let callback = entryRefCallbacks.current.get(index);
    if (!callback) {
      callback = (element) => {
        if (element) entryRefs.current.set(index, element);
        else {
          entryRefs.current.delete(index);
          entryRefCallbacks.current.delete(index);
        }
      };
      entryRefCallbacks.current.set(index, callback);
    }
    return callback;
  }, []);
  const setToolRef = useCallback((index: number, element: DOMElement | null) => {
    if (element) toolRefs.current.set(index, element);
    else toolRefs.current.delete(index);
  }, []);
  const [layoutMetrics, setLayoutMetrics] = useState({ contentHeight: 0, viewportHeight: 0, composerTop: 0, hasMeasured: false });
  const [transcriptHeightRevision, setTranscriptHeightRevision] = useState(0);
  const activeReasoningLabel = runtime.reasoningVariants.find((variant) => variant.id === reasoningVariantId)?.label ?? reasoningVariantId;
  const maxScrollTop = Math.max(0, layoutMetrics.contentHeight - layoutMetrics.viewportHeight);
  const scrollTop = Math.min(requestedScrollTop, maxScrollTop);
  // Folding a block shortens the transcript under a reader who is not following
  // the tail, so the clamp above quietly hides part of the requested offset.
  // Keeping that unreachable offset meant unfolding later threw the view back
  // down. Adopt the reachable position, but only when the content itself shrank:
  // measurement can also move the maximum while a wheel burst is still arriving,
  // and rewriting the request there would swallow notches.
  const previousMaxScrollTop = useRef(maxScrollTop);
  useEffect(() => {
    const shrank = maxScrollTop < previousMaxScrollTop.current;
    previousMaxScrollTop.current = maxScrollTop;
    if (!shrank || followTail.current) return;
    if (requestedScrollTop > maxScrollTop) setRequestedScrollTop(maxScrollTop);
  }, [maxScrollTop, requestedScrollTop]);
  const scrollTopRef = useRef(scrollTop);
  scrollTopRef.current = scrollTop;
  const scrollBy = useCallback(
    (delta: number) => {
      if (delta === 0) return;
      // Read the pending offset from a ref, not from the rendered value: this
      // callback is rebuilt only when maxScrollTop changes, so a captured
      // `scrollTop` stays frozen while the user scrolls. A wheel burst also
      // delivers several events before the next render. Both cases collapse
      // every notch onto the same target, which reads as "it scrolls once and
      // then stops".
      const current = followTail.current ? maxScrollTop : scrollTopRef.current;
      const next = Math.max(0, Math.min(maxScrollTop, current - delta));
      scrollTopRef.current = next;
      if (next >= maxScrollTop) {
        followTail.current = true;
        setRequestedScrollTop(Number.MAX_SAFE_INTEGER);
      } else {
        followTail.current = false;
        setRequestedScrollTop(next);
      }
    },
    [maxScrollTop],
  );
  const scrollByRef = useRef(scrollBy);
  scrollByRef.current = scrollBy;

  useEffect(() => {
    if (followTail.current) setRequestedScrollTop(Number.MAX_SAFE_INTEGER);
  }, [entries]);
  const slashQuery = largePasteContent || imageAttachments.length > 0 ? '' : (composerText.trimStart().split(/\s/, 1)[0] ?? '');
  const slashSuggestions = slashQuery.startsWith('/') ? slashCommands.filter(({ command }) => command.startsWith(slashQuery)) : [];
  const popupOpen = settingsOpen || permissionsOpen || reasoningOpen || thinkingOpen || providerOpen || sessionChooserOpen;
  const slashMenuVisible = pending === null && pendingQuestion === null && !popupOpen && slashSuggestions.length > 0;
  const tokens = useMemo(() => uiTokens(selectedTheme, systemTheme), [selectedTheme, systemTheme]);
  useEffect(() => {
    const viewportNode = viewportRef.current;
    const composerNode = composerSlotRef.current;
    if (!viewportNode || !composerNode) return;

    const viewportHeight = measureElement(viewportNode).clientHeight;
    const composerTop = measureElement(composerNode).y;
    setLayoutMetrics((previous) =>
      previous.hasMeasured && previous.viewportHeight === viewportHeight && previous.composerTop === composerTop
        ? previous
        : { ...previous, viewportHeight, composerTop, hasMeasured: true },
    );
  }, [
    rows,
    columns,
    pending,
    pendingQuestionId,
    expandedCommand,
    queuedMessageCount,
    escapeWarning,
    composerKey,
    composerText,
    largePasteContent,
    imageAttachments,
    composerNotice,
    popupOpen,
    slashMenuVisible,
    busy,
    sessionSaveError,
  ]);
  const slashMenuHeight = slashSuggestions.length + 2;
  const queuedPreviews = queuedMessages.slice(0, QUEUED_CARD_PREVIEW_LIMIT).map(formatQueuedPreview);
  const queuedOverflowCount = Math.max(0, queuedMessageCount - queuedPreviews.length);
  // Header row + preview rows + overflow row + top/bottom borders.
  const queuedMessageCardHeight = queuedMessageCount > 0 ? queuedPreviews.length + (queuedOverflowCount > 0 ? 1 : 0) + 3 : 0;
  const queuedMessageCardTop = Math.max(0, layoutMetrics.composerTop - queuedMessageCardHeight - 1);
  const slashMenuTop = layoutMetrics.hasMeasured
    ? Math.max(0, layoutMetrics.composerTop - slashMenuHeight - 1 - (queuedMessageCount > 0 ? queuedMessageCardHeight + 1 : 0))
    : Math.max(0, rows - slashMenuHeight - 7 - (queuedMessageCount > 0 ? queuedMessageCardHeight + 1 : 0));
  const normalizedSessionSearch = sessionSearch.trim().toLocaleLowerCase('en-US');
  const filteredSessions = savedSessions.filter((session) =>
    `${session.title} ${session.preview} ${session.providerId} ${session.modelId}`
      .toLocaleLowerCase('en-US')
      .includes(normalizedSessionSearch),
  );
  const sessionChoices: SessionChoice[] = [
    { kind: 'new' },
    ...filteredSessions.map((session): SessionChoice => ({ kind: 'saved', session })),
  ];
  const selectedSessionIndex = Math.min(sessionSelection, sessionChoices.length - 1);
  const sessionWindowSize = Math.max(1, Math.min(6, rows - 17));
  const sessionListStart = Math.max(0, Math.min(selectedSessionIndex - sessionWindowSize + 1, sessionChoices.length - sessionWindowSize));
  const visibleSessionChoices = sessionChoices.slice(sessionListStart, sessionListStart + sessionWindowSize);
  const flushSessionSave = useCallback(async () => {
    await controller.flushSave();
  }, [controller]);

  const handleComposerChange = useCallback((value: string) => {
    setSelectedSlashIndex(0);
    setComposerNotice(null);
    setComposerText(value);
  }, []);

  const handleLargePaste = useCallback((value: string) => {
    setSelectedSlashIndex(0);
    setComposerNotice(null);
    setLargePasteContent((previous) => (previous ? `${previous}\n${value}` : value));
    setComposerText('');
    setComposerKey((key) => key + 1);
  }, []);

  const pasteClipboardImage = useCallback(async (allowSystemFallback = true, showMissingNotice = true) => {
    try {
      const base64 = await readClipboardImageBase64(allowSystemFallback);
      if (!base64) {
        if (showMissingNotice) {
          setComposerNotice('No image found on the clipboard.');
          setComposerKey((key) => key + 1);
        }
        return false;
      }
      if (Math.floor((base64.length * 3) / 4) > MAX_CLIPBOARD_IMAGE_BYTES) {
        setComposerNotice('Clipboard image is larger than 5 MB.');
        setComposerKey((key) => key + 1);
        return false;
      }
      setImageAttachments((images) => [...images, { base64, mediaType: 'image/png' }]);
      setComposerKey((key) => key + 1);
      setComposerNotice(null);
      return true;
    } catch {
      if (showMissingNotice) {
        setComposerNotice('Clipboard image paste is unavailable on this system.');
        setComposerKey((key) => key + 1);
      }
      return false;
    }
  }, []);

  const finishApproval = useCallback(
    (decision: ApprovalDecision) => {
      if (pendingApprovalId) controller.approveToolCall(decision, pendingApprovalId);
    },
    [controller, pendingApprovalId],
  );

  const answerQuestion = useCallback(
    (answer: string | null) => {
      if (pendingQuestionId) controller.answerQuestion(answer, pendingQuestionId);
    },
    [controller, pendingQuestionId],
  );

  const submitQuestionAnswer = useCallback(
    (text: string) => {
      const typed = text.trim();
      const selected = pendingQuestionOptions[Math.min(questionSelection, Math.max(0, pendingQuestionOptions.length - 1))];
      const answer = typed || selected;
      if (!answer) return;
      answerQuestion(answer);
      setQuestionText('');
      setQuestionKey((key) => key + 1);
    },
    [answerQuestion, pendingQuestionOptions, questionSelection],
  );

  const handleRunEscape = useCallback(() => {
    if (!controller.isBusy) return;
    if (escapeStopArmed.current) {
      escapeStopArmed.current = false;
      if (escapeStopTimer.current !== null) clearTimeout(escapeStopTimer.current);
      escapeStopTimer.current = null;
      setEscapeWarning('Stopping run… Queued messages are kept and will not start on their own.');
      // Esc never drops user input: queued messages stay visible in the chat and
      // wait for the next explicit send instead of starting a run by themselves.
      controller.stop({ keepQueue: true, holdQueue: true });
      return;
    }

    escapeStopArmed.current = true;
    setEscapeWarning('Press Esc again to stop.');
    escapeStopTimer.current = setTimeout(() => {
      escapeStopArmed.current = false;
      escapeStopTimer.current = null;
      setEscapeWarning(null);
    }, 1_500);
  }, [controller]);

  useEffect(
    () => () => {
      if (escapeStopTimer.current !== null) clearTimeout(escapeStopTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!composerNotice) return;
    const timer = setTimeout(() => setComposerNotice(null), 5_000);
    return () => clearTimeout(timer);
  }, [composerNotice]);

  // Global rule for the top banner: no transient notice sticks. The stop
  // confirmation clears as soon as the run is no longer busy, and any
  // lingering banner is force-cleared after a timeout.
  useEffect(() => {
    if (busy) return;
    setEscapeWarning(null);
  }, [busy]);

  useEffect(() => {
    if (!escapeWarning) return;
    const timer = setTimeout(() => setEscapeWarning(null), 5_000);
    return () => clearTimeout(timer);
  }, [escapeWarning]);

  const addEntry = useCallback(
    (entry: Entry) => {
      controller.addEntry(entry);
      if (followTail.current) setRequestedScrollTop(Number.MAX_SAFE_INTEGER);
    },
    [controller],
  );

  const openSessionPicker = useCallback(async () => {
    if (controller.isBusy) {
      addEntry({ kind: 'notice', text: 'Wait for the current run to finish before switching sessions.', tone: 'warn' });
      return;
    }
    await flushSessionSave();
    try {
      setSavedSessions(await controller.listSessions());
    } catch (error) {
      addEntry({
        kind: 'notice',
        text: `Could not read saved sessions: ${error instanceof Error ? error.message : String(error)}`,
        tone: 'error',
      });
      setSavedSessions([]);
    }
    setSessionSearch('');
    setSessionSelection(0);
    setSessionChooserOpen(true);
  }, [addEntry, controller, flushSessionSave]);

  const openProviderPicker = useCallback(() => {
    if (controller.isBusy) {
      addEntry({ kind: 'notice', text: 'Wait for the current run to finish before changing providers.', tone: 'warn' });
      return;
    }
    setProviderPickerMode('provider');
    setProviderOpen(true);
  }, [addEntry, controller]);

  const openModelPicker = useCallback(() => {
    if (controller.isBusy) {
      addEntry({ kind: 'notice', text: 'Wait for the current run to finish before changing models.', tone: 'warn' });
      return;
    }
    setProviderPickerMode('models');
    setProviderOpen(true);
  }, [addEntry, controller]);

  const applyProviderModel = useCallback(
    async (providerId: string, modelId: string) => {
      await controller.selectModel(providerId, modelId);
      const settings = loadSettings();
      rememberProviderModel(settings, providerId, modelId);
      writeSettings(settings);
      const reasoning = resolveReasoningVariant(runtime.reasoningVariants, runtime.reasoningDefault).id;
      setReasoningVariantId(reasoning);
      setReasoningSelection(
        Math.max(
          0,
          runtime.reasoningVariants.findIndex((variant) => variant.id === reasoning),
        ),
      );
      setProviderOpen(false);
      setComposerNotice(`Model selected: ${providerId} / ${modelId}`);
    },
    [controller, runtime],
  );

  const chooseSession = useCallback(
    async (choice: SessionChoice) => {
      if (controller.isBusy) return;
      await flushSessionSave();
      if (choice.kind === 'new') {
        await controller.createNewSession();
      } else {
        try {
          const loaded = await controller.loadSession(choice.session.id);
          if (!loaded) {
            setSavedSessions(await controller.listSessions());
            addEntry({ kind: 'notice', text: 'That session is no longer available.', tone: 'warn' });
            return;
          }
        } catch (error) {
          addEntry({ kind: 'notice', text: `Could not open session: ${error instanceof Error ? error.message : String(error)}` });
          return;
        }
      }

      entryRefs.current.clear();
      entryRefCallbacks.current.clear();
      entryHeightCache.current = new WeakMap();
      setExpandedTools(new Set());
      setExpandedMessages(new Set());
      setExpandedNotices(new Set());
      setToggledReasoning(new Set());
      toolRefs.current.clear();
      setSessionChooserOpen(false);
      followTail.current = true;
      setRequestedScrollTop(Number.MAX_SAFE_INTEGER);
    },
    [addEntry, controller, flushSessionSave],
  );

  const turnPreferences = useCallback(
    () => ({
      reasoningVariantId,
      showReasoning: showReasoningRef.current,
    }),
    [reasoningVariantId],
  );

  const send = useCallback(
    async (raw: string, attachedImages: ClipboardImage[] = []) => {
      const typedText = raw.trim();
      const text = [largePasteContent.trim(), typedText].filter(Boolean).join('\n').trim();
      const messageText = text || (attachedImages.length > 0 ? IMAGE_ONLY_PROMPT : '');
      const commandOnly = !largePasteContent && attachedImages.length === 0;
      setComposerKey((key) => key + 1);
      setComposerText('');
      setLargePasteContent('');
      setImageAttachments([]);
      setComposerNotice(null);
      if (text) setInputHistory((history) => (history[history.length - 1] === text ? history : [...history, text]));
      if (!text && attachedImages.length === 0) return;

      if (commandOnly && text === '/settings') {
        setSettingsSelection(Math.max(0, themeOptions.indexOf(selectedTheme)));
        setSettingsOpen(true);
        return;
      }
      if (commandOnly && text === '/permissions') {
        setPermissionsSelection(runtime.approvalMode === 'full-access' ? 2 : runtime.approvalMode === 'auto-review' ? 1 : 0);
        setPermissionsOpen(true);
        return;
      }
      if (commandOnly && text === '/reasoning') {
        const index = runtime.reasoningVariants.findIndex((variant) => variant.id === reasoningVariantId);
        setReasoningSelection(Math.max(0, index));
        setReasoningOpen(true);
        return;
      }
      if (commandOnly && text === '/thinking') {
        setThinkingSelection(showReasoningRef.current ? 1 : 0);
        setThinkingOpen(true);
        return;
      }
      if (commandOnly && text === '/compact') {
        void controller.compact(turnPreferences());
        return;
      }
      if (commandOnly && text === '/stop') {
        controller.stop({ keepQueue: true });
        addEntry({ kind: 'notice', text: 'Stopping the current run; queued messages are kept.' });
        return;
      }
      if (commandOnly && text === '/provider') {
        openProviderPicker();
        return;
      }
      if (commandOnly && text === '/models') {
        openModelPicker();
        return;
      }
      if (commandOnly && text === '/session') {
        await openSessionPicker();
        return;
      }
      if (commandOnly && text === '/skills') {
        const { discoverSkills, getSkillRoots } = await import('../skills.js');
        const skills = discoverSkills(runtime.workspaceRoot);
        const summary =
          skills.length > 0
            ? [
                ...skills.slice(0, 12).map((skill) => skill.name + ' [' + skill.scope + ']: ' + skill.description),
                ...(skills.length > 12 ? ['... ' + (skills.length - 12) + ' more. Run openbutler skills for the full list.'] : []),
              ].join('\n')
            : 'No Agent Skills found. Search paths: ' +
              getSkillRoots(runtime.workspaceRoot)
                .map((root) => root.path)
                .join(', ');
        addEntry({ kind: 'notice', text: summary });
        return;
      }
      if (commandOnly && (text === '/exit' || text === '/quit')) {
        if (controller.isBusy) addEntry({ kind: 'notice', text: 'Wait for the current run to finish before exiting.', tone: 'warn' });
        else exit();
        return;
      }
      if (commandOnly && text === '/clear') {
        if (controller.isBusy) {
          addEntry({ kind: 'notice', text: 'Wait for the current run to finish before clearing the session.', tone: 'warn' });
          return;
        }
        await flushSessionSave();
        await controller.createNewSession();
        entryRefs.current.clear();
        entryRefCallbacks.current.clear();
        entryHeightCache.current = new WeakMap();
        setExpandedTools(new Set());
        setExpandedMessages(new Set());
        setExpandedNotices(new Set());
        setToggledReasoning(new Set());
        toolRefs.current.clear();
        followTail.current = true;
        setRequestedScrollTop(Number.MAX_SAFE_INTEGER);
        return;
      }
      if (commandOnly && text === '/help') {
        addEntry({
          kind: 'notice',
          text: `Commands: ${slashCommands.map(({ command }) => command).join(', ')}.`,
        });
        return;
      }

      escapeStopArmed.current = false;
      if (escapeStopTimer.current !== null) clearTimeout(escapeStopTimer.current);
      escapeStopTimer.current = null;
      setEscapeWarning(null);
      void controller.sendMessage({ text: messageText, images: attachedImages }, turnPreferences());
    },
    [
      addEntry,
      controller,
      exit,
      flushSessionSave,
      largePasteContent,
      openModelPicker,
      openProviderPicker,
      openSessionPicker,
      reasoningVariantId,
      runtime,
      selectedTheme,
      turnPreferences,
    ],
  );

  const terminalCommand =
    pending?.providerId === 'host' && pending.name === 'execute_command' && typeof pending.input.command === 'string'
      ? pending.input.command
      : null;
  const safeCommand = terminalCommand === null ? null : displayableCommand(terminalCommand);
  const oneLineCommand = safeCommand?.replace(/\n/g, ' ↵ ').replace(/\t/g, '\\t') ?? '';
  const previewLimit = Math.max(8, composerWidth - 8);
  const commandNeedsExpand = terminalCommand !== null && terminalTextWidth(oneLineCommand) > previewLimit;
  const approvalInputLine = pending && safeCommand === null ? compactApprovalInput(pending.input, false) : '';
  const approvalInputNeedsExpand =
    pending !== null &&
    safeCommand === null &&
    (terminalTextWidth(approvalInputLine) > previewLimit || hasExpandableApprovalInput(pending.input));
  const approvalContentNeedsExpand = commandNeedsExpand || approvalInputNeedsExpand;
  const approvalPreview =
    safeCommand === null
      ? formatApprovalInput(pending?.input ?? {}, expandedCommand, previewLimit)
      : expandedCommand
        ? safeCommand
        : clipTerminalWidth(oneLineCommand, previewLimit);
  let approvalNote: string | null = null;
  if (pending?.providerId === 'host' && pending.name === 'file_read') {
    approvalNote = 'File contents will be sent to the model.';
  } else if (pending?.providerId === 'host' && pending.name === 'grep') {
    approvalNote = 'Matching file lines will be sent to the model.';
  } else if (pending?.providerId === 'host' && (pending.name === 'file_write' || pending.name === 'file_edit')) {
    approvalNote = pending.name === 'file_edit' ? 'Modifies an existing file in place.' : 'Replaces the entire file content.';
  } else if (pending?.providerId === 'host' && pending.name === 'execute_command' && typeof pending.input.cwd === 'string') {
    approvalNote = `Working directory: ${pending.input.cwd}`;
  } else if (pending?.providerId === 'host' && pending.name === 'mcp_manage') {
    const action = String(pending.input.action ?? '');
    approvalNote =
      action === 'add'
        ? 'Adds global MCP settings and starts or contacts the server.'
        : action === 'connect'
          ? 'Connects to the MCP server; its tools remain separately approved.'
          : action === 'disconnect'
            ? 'Disconnects this MCP server for the active session.'
            : action === 'remove'
              ? 'Removes global MCP settings and stops the active connection.'
              : null;
  }
  if (queuedMessageCount > 0) approvalNote = `${approvalNote ? approvalNote + ' · ' : ''}${queuedMessageCount} queued`;
  const busyHint = 'Esc to stop · Enter to queue';
  // The question and approval cards print their own hints; the footer stays out
  // of their way and only describes the run itself.
  const footerHint = pending ? '←/→ choose · Enter confirm' : busy ? `running · ${busyHint}` : '';
  const footerMeta = `${runtime.modelId} · ${activeReasoningLabel} · ${formatContextIndicator(activeSession.contextTokens, activeSession.contextWindowTokens)}`;
  const approvalPanelBottom = layoutMetrics.hasMeasured ? layoutMetrics.composerTop + COMPOSER_SLOT_HEIGHT : rows - 5;
  const approvalPanelTop = Math.max(0, approvalPanelBottom - approvalPanelHeight);
  useEffect(() => {
    if (pending) {
      setApprovalSelection(0);
      setExpandedCommand(false);
    }
  }, [pending]);
  useEffect(() => {
    setQuestionSelection(0);
  }, [pendingQuestionId]);
  useEffect(() => {
    if (!pending || !approvalPanelRef.current) return;
    const height = measureElement(approvalPanelRef.current).height;
    if (Number.isFinite(height) && height > 0) {
      setApprovalPanelHeight((previous) => (previous === height ? previous : height));
    }
  }, [pending, approvalNote, approvalPreview, composerWidth]);
  const queuedCardTitle = queuedMessageCount === 1 ? '1 queued message' : `${queuedMessageCount} queued messages`;

  const transcriptLayout = useMemo(() => {
    const heights: number[] = [];
    const offsets: number[] = [];
    let contentHeight = 0;
    entries.forEach((entry, index) => {
      const streaming = entry.kind === 'assistant' && entry === snapshot.streamingAssistantEntry;
      const reasoningHidden = entry.kind === 'reasoning' && !showReasoning;
      const layoutKey = transcriptEntryLayoutKey(
        width,
        entry.kind === 'tool' && expandedTools.has(index),
        entry.kind === 'user' && expandedMessages.has(index),
        entry.kind === 'notice' && expandedNotices.has(index),
        mouseInput.supported,
        streaming,
        reasoningHidden,
        entry.kind === 'reasoning' && toggledReasoning.has(index),
      );
      let height = entryHeightCache.current.get(entry)?.get(layoutKey);
      if (height === undefined) {
        height = estimateTranscriptEntryHeight(
          entry,
          width,
          entry.kind === 'tool' && expandedTools.has(index),
          entry.kind === 'user' && expandedMessages.has(index),
          entry.kind === 'notice' && expandedNotices.has(index),
          mouseInput.supported,
          reasoningHidden,
          entry.kind === 'reasoning' && toggledReasoning.has(index),
        );
        let cachedHeights = entryHeightCache.current.get(entry);
        if (!cachedHeights) {
          cachedHeights = new Map<string, number>();
          entryHeightCache.current.set(entry, cachedHeights);
        }
        cachedHeights.set(layoutKey, height);
      }
      offsets.push(contentHeight);
      heights.push(height);
      contentHeight += height;
    });
    offsets.push(contentHeight);
    return { heights, offsets, contentHeight };
  }, [
    entries,
    expandedMessages,
    expandedNotices,
    expandedTools,
    mouseInput.supported,
    showReasoning,
    snapshot.streamingAssistantEntry,
    toggledReasoning,
    transcriptHeightRevision,
    width,
  ]);

  const viewportHeight = layoutMetrics.viewportHeight || rows;
  const overscan = Math.max(6, viewportHeight);
  const firstVisibleOffset = Math.max(0, scrollTop - overscan);
  const lastVisibleOffset = scrollTop + viewportHeight + overscan;
  const transcriptStartIndex = lowerBoundTranscriptRow(transcriptLayout.offsets, transcriptLayout.heights, firstVisibleOffset);
  let transcriptEndIndex = transcriptStartIndex;
  while (transcriptEndIndex < entries.length && transcriptLayout.offsets[transcriptEndIndex]! < lastVisibleOffset) {
    transcriptEndIndex++;
  }
  if (entries.length > 0 && transcriptStartIndex < entries.length && transcriptEndIndex === transcriptStartIndex) transcriptEndIndex++;
  const transcriptTopSpace = transcriptLayout.offsets[transcriptStartIndex] ?? transcriptLayout.contentHeight;
  const transcriptBottomSpace = Math.max(
    0,
    transcriptLayout.contentHeight - (transcriptLayout.offsets[transcriptEndIndex] ?? transcriptLayout.contentHeight),
  );

  const transcriptRows = useMemo(
    () =>
      entries.slice(transcriptStartIndex, transcriptEndIndex).map((entry, visibleOffset) => {
        const index = transcriptStartIndex + visibleOffset;
        const expanded = entry.kind === 'tool' && expandedTools.has(index);
        const expandedMessage = entry.kind === 'user' && expandedMessages.has(index);
        const expandedNotice = entry.kind === 'notice' && expandedNotices.has(index);
        const reasoningToggled = entry.kind === 'reasoning' && toggledReasoning.has(index);
        const streaming = entry.kind === 'assistant' && entry === snapshot.streamingAssistantEntry;
        // The render window reaches past the viewport so scrolling has somewhere to
        // land, but rows outside the viewport are clipped and never drawn. Laying
        // out their text is pure cost: the frame pays for every character, long
        // entries pay for thousands of invisible rows. Keep the geometry with a
        // fixed-height placeholder and render the real entry only when at least
        // one of its rows can be seen.
        const entryTop = transcriptLayout.offsets[index] ?? 0;
        const entryHeight = transcriptLayout.heights[index] ?? 0;
        const onScreen = entryHeight > 0 && entryTop + entryHeight > scrollTop && entryTop < scrollTop + viewportHeight;
        // An entry taller than the viewport can only ever show this row span, so
        // the rest of its text never has to be laid out.
        const rowWindow =
          entryHeight > viewportHeight
            ? {
                top: Math.max(0, scrollTop - entryTop),
                bottom: Math.min(entryHeight, scrollTop + viewportHeight - entryTop),
              }
            : undefined;
        const rowKey = `${activeSession.id}:${index}:${entry.kind}:${width}:${expanded}:${expandedMessage}:${expandedNotice}:${reasoningToggled}:${popupOpen}:${mouseInput.supported}:${streaming}:${selectedTheme}:${showReasoning}:${onScreen ? 'onscreen' : `offscreen-${entryHeight}`}:${rowWindow ? `window-${rowWindow.top}-${rowWindow.bottom}` : 'full'}`;
        const cached = transcriptRowCache.current.get(entry);
        if (cached?.key === rowKey) return cached.element;
        const element = onScreen ? (
          <Box key={`${activeSession.id}-${index}-${entry.kind}`} ref={getEntryRef(index)} width="100%" flexShrink={0}>
            <TranscriptEntry
              entry={entry}
              index={index}
              width={width}
              streaming={streaming}
              expanded={expanded}
              expandedMessage={expandedMessage}
              expandedNotice={expandedNotice}
              reasoningToggled={reasoningToggled}
              hideReasoning={!showReasoning}
              dimmed={popupOpen}
              setToolRef={setToolRef}
              mouseSupported={mouseInput.supported}
              tokens={tokens}
              {...(rowWindow ? { rowWindow } : {})}
            />
          </Box>
        ) : (
          <Box key={`${activeSession.id}-${index}-${entry.kind}`} width="100%" height={entryHeight} flexShrink={0} />
        );
        transcriptRowCache.current.set(entry, { key: rowKey, element });
        return element;
      }),
    [
      activeSession.id,
      entries,
      expandedMessages,
      expandedNotices,
      expandedTools,
      getEntryRef,
      mouseInput.supported,
      popupOpen,
      selectedTheme,
      setToolRef,
      showReasoning,
      snapshot.streamingAssistantEntry,
      transcriptEndIndex,
      transcriptLayout.heights,
      transcriptLayout.offsets,
      transcriptStartIndex,
      scrollTop,
      viewportHeight,
      width,
    ],
  );

  useEffect(() => {
    let contentHeight = 0;
    let changedHeights = false;
    let heightDeltaBeforeAnchor = 0;
    const anchorIndex = lowerBoundTranscriptRow(transcriptLayout.offsets, transcriptLayout.heights, scrollTopRef.current);
    const heights = [...transcriptLayout.heights];
    for (let index = transcriptStartIndex; index < transcriptEndIndex; index++) {
      const entry = entries[index]!;
      const streaming = entry.kind === 'assistant' && entry === snapshot.streamingAssistantEntry;
      const layoutKey = transcriptEntryLayoutKey(
        width,
        entry.kind === 'tool' && expandedTools.has(index),
        entry.kind === 'user' && expandedMessages.has(index),
        entry.kind === 'notice' && expandedNotices.has(index),
        mouseInput.supported,
        streaming,
        entry.kind === 'reasoning' && !showReasoning,
        entry.kind === 'reasoning' && toggledReasoning.has(index),
      );
      // Measuring is a full layout pass; a stable entry identity and layout key stays valid.
      let height = measuredHeightCache.current.get(entry)?.get(layoutKey);
      if (height === undefined) {
        const element = entryRefs.current.get(index);
        const measured = element ? measureElement(element).height : transcriptLayout.heights[index]!;
        height = Number.isFinite(measured) && measured >= 0 ? measured : transcriptLayout.heights[index]!;
        if (element) {
          let measuredHeights = measuredHeightCache.current.get(entry);
          if (!measuredHeights) {
            measuredHeights = new Map<string, number>();
            measuredHeightCache.current.set(entry, measuredHeights);
          }
          measuredHeights.set(layoutKey, height);
        }
      }
      if (index < anchorIndex) heightDeltaBeforeAnchor += height - transcriptLayout.heights[index]!;
      let cachedHeights = entryHeightCache.current.get(entry);
      if (!cachedHeights) {
        cachedHeights = new Map<string, number>();
        entryHeightCache.current.set(entry, cachedHeights);
      }
      if (cachedHeights.get(layoutKey) !== height) {
        cachedHeights.set(layoutKey, height);
        changedHeights = true;
      }
      heights[index] = height;
    }
    contentHeight = heights.reduce((total, height) => total + height, 0);
    setLayoutMetrics((previous) =>
      previous.contentHeight === contentHeight && !changedHeights ? previous : { ...previous, contentHeight, hasMeasured: true },
    );
    if (!followTail.current && heightDeltaBeforeAnchor !== 0) {
      setRequestedScrollTop((current) => Math.max(0, current + heightDeltaBeforeAnchor));
    }
    if (changedHeights) setTranscriptHeightRevision((revision) => revision + 1);
  }, [
    entries,
    expandedMessages,
    expandedNotices,
    expandedTools,
    mouseInput.supported,
    showReasoning,
    snapshot.streamingAssistantEntry,
    toggledReasoning,
    transcriptEndIndex,
    transcriptLayout,
    transcriptStartIndex,
    width,
  ]);

  const mouseState = useRef({ entries, width, pending, approvalContentNeedsExpand, finishApproval, expandedTools });
  mouseState.current = { entries, width, pending, approvalContentNeedsExpand, finishApproval, expandedTools };

  const closeSubagentView = useCallback(() => {
    const client = subagentClientRef.current;
    subagentClientRef.current = null;
    setSubagentView(null);
    if (client) void client.close();
  }, []);
  const closeSubagentViewRef = useRef(closeSubagentView);
  closeSubagentViewRef.current = closeSubagentView;

  const openSubagentView = useCallback(
    async (index: number) => {
      if (subagentClientRef.current) return;
      const entry = subagentCall(entries[index]);
      if (!entry) return;
      const running = entry.running === true || entry.preparing === true;
      const workerSessionId = running ? null : subagentWorkerSessionId(entry);
      if (!running && !workerSessionId) {
        parentController.addEntry({ kind: 'notice', text: 'This subagent call did not open a worker session.' });
        return;
      }
      try {
        const { connectDaemonSession } = await import('../daemon-client.js');
        const client = await connectDaemonSession(
          parentController.runtime.workspaceRoot,
          running ? { runningWorkerOf: activeSession.id } : { workerSessionId: workerSessionId! },
        );
        if (subagentClientRef.current) {
          void client.close();
          return;
        }
        subagentClientRef.current = client;
        followTail.current = true;
        setRequestedScrollTop(Number.MAX_SAFE_INTEGER);
        setSubagentView(client);
      } catch (error) {
        parentController.addEntry({
          kind: 'notice',
          text: `Could not open the subagent session: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [activeSession.id, entries, parentController],
  );
  const openSubagentViewRef = useRef(openSubagentView);
  openSubagentViewRef.current = openSubagentView;
  const repaintSelection = useCallback(() => {
    const frame = selection.repaint();
    if (frame) process.stdout.write(frame);
  }, [selection]);
  const clearSelection = useCallback(() => {
    if (!selection.selection() && !selection.isDragging) return;
    selection.clear();
    repaintSelection();
  }, [repaintSelection, selection]);
  /**
   * Copies the selection through the in-app path, which drops layout chrome
   * such as the prompt glyph. Everything else is the text the frame shows, so
   * Ctrl+C and a finished drag both copy the same thing.
   */
  const copySelection = useCallback(() => {
    const copied = selection.text();
    if (!copied) return false;
    writeClipboardText(copied);
    setComposerNotice(`Copied ${copied.length} characters to the clipboard.`);
    return true;
  }, [selection]);
  const handleMouseEvent = useCallback(
    (event: MouseInputEvent) => {
      const state = mouseState.current;
      if (event.kind === 'wheel-up') {
        clearSelection();
        scrollByRef.current(3);
        return;
      }
      if (event.kind === 'wheel-down') {
        clearSelection();
        scrollByRef.current(-3);
        return;
      }
      if (event.kind === 'press') {
        if (selection.selection()) {
          selection.clear();
          repaintSelection();
        }
        selection.press({ row: event.y, col: event.x });
        return;
      }
      if (event.kind === 'drag') {
        if (selection.drag({ row: event.y, col: event.x })) repaintSelection();
        return;
      }
      const gesture = selection.release();
      if (gesture === 'selection') {
        repaintSelection();
        // A finished drag copies on its own; the highlight stays so Ctrl+C can
        // copy it again and a wheel event clears it as before.
        copySelection();
        return;
      }
      const { x, y } = event;
      if (state.pending) {
        for (const [decision, element] of approvalButtonRefs.current) {
          const bounds = measureElement(element);
          if (x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height) {
            state.finishApproval(decision);
            return;
          }
        }
      }
      if (state.pending) {
        if (state.approvalContentNeedsExpand && commandRef.current) {
          const bounds = measureElement(commandRef.current);
          if (x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height) {
            setExpandedCommand((expanded) => !expanded);
          }
        }
        return;
      }
      for (const [index, element] of toolRefs.current) {
        const entry = subagentCall(state.entries[index]);
        if (!entry) continue;
        const bounds = measureElement(element);
        const top = bounds.y - scrollTopRef.current;
        // The input toggles disclosure; the result still opens the worker view.
        const inputRows = state.expandedTools.has(index)
          ? estimateTranscriptEntryHeight({ ...entry, result: '', running: false, preparing: false }, state.width, true) - 1
          : 1;
        if (entry.input && y < top + inputRows) continue;
        if (x >= bounds.x && x < bounds.x + bounds.width && y >= top && y < top + bounds.height) {
          void openSubagentViewRef.current(index);
          return;
        }
      }
      for (const [index, element] of toolRefs.current) {
        const entry = state.entries[index];
        if (entry?.kind !== 'tool' || !toolNeedsExpand(entry, state.width)) continue;
        const bounds = measureElement(element);
        const top = bounds.y - scrollTopRef.current;
        if (x >= bounds.x && x < bounds.x + bounds.width && y >= top && y < top + bounds.height) {
          setExpandedTools((expanded) => {
            const next = new Set(expanded);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
          });
          return;
        }
      }
      for (const [index, element] of entryRefs.current) {
        const entry = state.entries[index];
        if (entry?.kind !== 'user' || !userMessageNeedsExpand(entry)) continue;
        const bounds = measureElement(element);
        const top = bounds.y - scrollTopRef.current;
        if (x >= bounds.x && x < bounds.x + bounds.width && y >= top && y < top + bounds.height) {
          setExpandedMessages((expanded) => {
            const next = new Set(expanded);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
          });
          return;
        }
      }
      for (const [index, element] of entryRefs.current) {
        const entry = state.entries[index];
        if (entry?.kind !== 'notice' || !entry.detail) continue;
        const bounds = measureElement(element);
        const top = bounds.y - scrollTopRef.current;
        if (x >= bounds.x && x < bounds.x + bounds.width && y >= top && y < top + bounds.height) {
          setExpandedNotices((expanded) => {
            const next = new Set(expanded);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
          });
          return;
        }
      }
      for (const [index, element] of entryRefs.current) {
        const entry = state.entries[index];
        if (entry?.kind !== 'reasoning') continue;
        const bounds = measureElement(element);
        const top = bounds.y - scrollTopRef.current;
        // The whole block toggles, not just the header row: the block is a single
        // unit and clicking anywhere on it should fold or unfold it. A drag still
        // wins, because a finished selection returns before this loop runs.
        if (x >= bounds.x && x < bounds.x + bounds.width && y >= top && y < top + bounds.height) {
          setToggledReasoning((toggled) => {
            const next = new Set(toggled);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
          });
          return;
        }
      }
    },
    [clearSelection, copySelection, repaintSelection, selection],
  );

  useEffect(() => {
    if (!mouseInput.supported) return;
    mouseInput.setMouseHandler(handleMouseEvent);
    return () => mouseInput.setMouseHandler(null);
  }, [handleMouseEvent, mouseInput]);

  useEffect(() => {
    if (!mouseInput.supported || popupOpen) return;
    process.stdout.write('\u001b[?1002h\u001b[?1006h');
    return () => {
      process.stdout.write('\u001b[?1006l\u001b[?1002l');
    };
  }, [mouseInput.supported, popupOpen]);

  useInput(
    (input, key) => {
      if (!key.ctrl || input.toLowerCase() !== 'c') return;
      if (copySelection()) {
        selection.clear();
        repaintSelection();
        return;
      }
      // Shell habit: Ctrl+C clears what you were typing before it stops or exits.
      if (composerText.length > 0 || largePasteContent.length > 0 || imageAttachments.length > 0) {
        setComposerKey((key) => key + 1);
        setComposerText('');
        setLargePasteContent('');
        setImageAttachments([]);
        setComposerNotice(null);
        return;
      }
      if (parentController.isBusy) parentController.stop();
      exit();
    },
    { isActive: true },
  );

  useInput(
    (input, key) => {
      if (!pending) return;
      if (key.escape) {
        // Esc exits the approval card: the pending action is denied. The same
        // press arms the run stop, so a second Esc stops the whole run.
        controller.approveToolCall('deny');
        handleRunEscape();
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const direction = key.rightArrow ? 1 : -1;
        setApprovalSelection((index) => (index + direction + approvalActions.length) % approvalActions.length);
        return;
      }
      if (approvalContentNeedsExpand && input === ' ') {
        setExpandedCommand((expanded) => !expanded);
        return;
      }
      if (key.return) finishApproval(approvalActions[approvalSelection]!.decision);
    },
    { isActive: pending !== null },
  );

  useInput(
    (_input, key) => {
      if (!pendingQuestion) return;
      if (key.escape) {
        answerQuestion(null);
        return;
      }
      if (pendingQuestionOptions.length === 0) return;
      if (key.downArrow) setQuestionSelection((index) => (index + 1) % pendingQuestionOptions.length);
      else if (key.upArrow) setQuestionSelection((index) => (index - 1 + pendingQuestionOptions.length) % pendingQuestionOptions.length);
    },
    { isActive: pendingQuestion !== null },
  );

  useInput(
    (_input, key) => {
      if (key.escape) handleRunEscape();
    },
    { isActive: busy && pending === null && pendingQuestion === null && !popupOpen && subagentView === null },
  );

  useInput(
    (_input, key) => {
      if (key.upArrow) closeSubagentViewRef.current();
    },
    { isActive: subagentView !== null },
  );

  useInput(
    (input, key) => {
      if ((key.meta || key.ctrl) && (input.toLowerCase() === 'v' || input === '\u0016')) {
        void pasteClipboardImage();
      }
    },
    { isActive: runtime.supportsVision && pending === null && !popupOpen },
  );

  useInput(
    (_input, key) => {
      if (popupOpen) return;
      if (subagentView !== null && key.upArrow) return;
      if (pendingQuestion !== null && (key.upArrow || key.downArrow)) return;
      if (slashMenuVisible && (key.upArrow || key.downArrow)) {
        const direction = key.downArrow ? 1 : -1;
        setSelectedSlashIndex((index) => (index + direction + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
      if (key.home && key.ctrl) {
        clearSelection();
        followTail.current = false;
        setRequestedScrollTop(0);
        return;
      }
      if (key.end && key.ctrl) {
        clearSelection();
        followTail.current = true;
        setRequestedScrollTop(Number.MAX_SAFE_INTEGER);
        return;
      }
      // Plain Home/End belong to the composer caret (SessionComposer); the
      // transcript only jumps on Ctrl+Home/End. Arrow keys belong to the
      // composer's history, so the transcript scrolls with PageUp/PageDown.
      const page = Math.max(1, Math.floor((layoutMetrics.viewportHeight || rows) / 2));
      const delta = key.pageUp ? page : key.pageDown ? -page : 0;
      if (delta !== 0) clearSelection();
      scrollBy(delta);
    },
    { isActive: true },
  );

  useInput(
    (input, key) => {
      if (providerOpen) return;
      if (key.escape) {
        setSettingsOpen(false);
        setPermissionsOpen(false);
        setReasoningOpen(false);
        setThinkingOpen(false);
        setSessionChooserOpen(false);
        return;
      }
      if (sessionChooserOpen) {
        if (key.upArrow || key.downArrow) {
          const direction = key.downArrow ? 1 : -1;
          setSessionSelection((index) => (index + direction + sessionChoices.length) % sessionChoices.length);
        } else if (key.return) {
          const choice = sessionChoices[selectedSessionIndex];
          if (choice) void chooseSession(choice);
        } else if (key.backspace || key.delete) {
          setSessionSearch((query) => query.slice(0, -1));
          setSessionSelection(0);
        } else if (key.ctrl && input.toLowerCase() === 'u') {
          setSessionSearch('');
          setSessionSelection(0);
        } else if (input && !key.ctrl && !key.meta && !key.super) {
          setSessionSearch((query) => query + input);
          setSessionSelection(0);
        }
        return;
      }
      if (reasoningOpen && key.upArrow) {
        setReasoningSelection((index) => (index + runtime.reasoningVariants.length - 1) % runtime.reasoningVariants.length);
      } else if (reasoningOpen && key.downArrow) {
        setReasoningSelection((index) => (index + 1) % runtime.reasoningVariants.length);
      } else if (reasoningOpen && key.return) {
        const variant = runtime.reasoningVariants[reasoningSelection];
        if (variant) {
          setReasoningVariantId(variant.id);
          try {
            runtime.saveReasoningPreference(variant.id);
          } catch (error) {
            addEntry({ kind: 'notice', text: error instanceof Error ? error.message : String(error) });
          }
        }
        setReasoningOpen(false);
      } else if (thinkingOpen && (key.upArrow || key.downArrow)) {
        setThinkingSelection((index) => (index + (key.downArrow ? 1 : -1) + 2) % 2);
      } else if (thinkingOpen && key.return) {
        const visible = thinkingSelection === 1;
        showReasoningRef.current = visible;
        setShowReasoning(visible);
        try {
          runtime.saveShowReasoningPreference(visible);
        } catch (error) {
          addEntry({ kind: 'notice', text: error instanceof Error ? error.message : String(error) });
        }
        // Display-only: reasoning entries stay in the session and reappear when
        // switched back on. Nothing is deleted.
        setThinkingOpen(false);
      } else if (settingsOpen && key.upArrow) {
        setSettingsSelection((index) => (index + themeOptions.length - 1) % themeOptions.length);
      } else if (settingsOpen && key.downArrow) {
        setSettingsSelection((index) => (index + 1) % themeOptions.length);
      } else if (settingsOpen && key.return) {
        const nextTheme = (themeOptions[settingsSelection] ?? themeOptions[0]!) as UiTheme;
        setSelectedTheme(nextTheme);
        try {
          const settings = loadSettings();
          settings.theme = nextTheme;
          writeSettings(settings);
        } catch (error) {
          setComposerNotice(error instanceof Error ? error.message : String(error));
        }
        setSettingsOpen(false);
      } else if (permissionsOpen && (key.upArrow || key.downArrow)) {
        setPermissionsSelection((index) => (index + (key.downArrow ? 1 : -1) + 3) % 3);
      } else if (permissionsOpen && key.return) {
        const mode = permissionsSelection === 2 ? 'full-access' : permissionsSelection === 1 ? 'auto-review' : 'workspace';
        const previousMode = runtime.approvalMode ?? 'workspace';
        setPermissionsOpen(false);
        runtime.approvalMode = mode;
        try {
          runtime.saveApprovalModePreference?.(mode);
        } catch (error) {
          runtime.approvalMode = previousMode;
          addEntry({ kind: 'notice', text: error instanceof Error ? error.message : String(error) });
        }
      }
    },
    { isActive: popupOpen },
  );

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={2} paddingY={1}>
      {entries.length === 0 ? (
        <Box flexDirection="column" alignItems="center" marginTop={2} marginBottom={2} flexShrink={0}>
          <Text bold dimColor={popupOpen} {...(popupOpen ? {} : { color: tokens.accent })}>
            OpenButler {getOpenButlerVersion()}
          </Text>
          <Text dimColor>{`${runtime.modelId} · ${activeReasoningLabel} · ${runtime.approvalMode}`}</Text>
          {runtime.workspaceRoot ? <Text dimColor>{clipTerminalWidth(runtime.workspaceRoot, Math.max(8, width - 8))}</Text> : null}
          <Text dimColor>Type a message or /help · Enter send · Esc×2 stop · Ctrl+Home/End top/bottom</Text>
        </Box>
      ) : (
        <Box width="100%" marginBottom={1} flexShrink={0}>
          <Text dimColor={popupOpen}>
            {hairlineText(
              clipped(activeSession.title, Math.max(8, Math.floor(width / 2))),
              clipped(runtime.workspaceRoot ?? '', Math.max(8, Math.floor(width / 3))),
              composerWidth,
            )}
          </Text>
        </Box>
      )}

      <Box
        ref={viewportRef}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        contentOffsetY={scrollTop}
        width="100%"
      >
        <Box flexDirection="column" flexShrink={0} width="100%">
          {transcriptTopSpace > 0 ? <Box height={transcriptTopSpace} flexShrink={0} /> : null}
          {transcriptRows}
          {transcriptBottomSpace > 0 ? <Box height={transcriptBottomSpace} flexShrink={0} /> : null}
        </Box>
      </Box>

      {slashMenuVisible ? (
        <Box position="absolute" top={slashMenuTop} left={0} width="100%" justifyContent="center">
          <Box
            width={composerWidth}
            flexDirection="column"
            borderStyle="single"
            borderDimColor
            backgroundColor={tokens.surface}
            paddingX={1}
          >
            {slashSuggestions.map((suggestion, index) => (
              <Box key={suggestion.command} width="100%" {...(index === selectedSlashIndex ? { backgroundColor: tokens.accent } : {})}>
                <Text
                  bold={index === selectedSlashIndex}
                  {...(index === selectedSlashIndex ? { color: tokens.onAccent } : { dimColor: true })}
                >
                  {index === selectedSlashIndex ? `${glyphs.prompt} ` : '  '}
                  {suggestion.command}
                  <Text {...(index === selectedSlashIndex ? { color: tokens.onAccent } : { dimColor: true })}>
                    {' '}
                    {suggestion.description}
                  </Text>
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      ) : null}

      {pendingQuestion ? (
        <Box width={composerWidth} marginBottom={1} flexDirection="column" flexShrink={0}>
          <Text bold>{pendingQuestion.question}</Text>
          {pendingQuestionOptions.length > 0 ? (
            <Box width="100%" flexDirection="column" marginTop={1} flexShrink={0}>
              {pendingQuestionOptions.map((option, index) => (
                <Text
                  key={index}
                  dimColor={questionSelection !== index}
                  bold={questionSelection === index}
                  {...(questionSelection === index ? { color: tokens.accent } : {})}
                >
                  {index + 1}. {option}
                </Text>
              ))}
            </Box>
          ) : null}
          <Box width="100%" flexDirection="row" marginTop={1} flexShrink={0}>
            <Text color={tokens.accent}>› </Text>
            <SessionComposer
              key={questionKey}
              value={questionText}
              disabled={popupOpen}
              placeholder="Type an answer…"
              attachmentCount={0}
              onChange={setQuestionText}
              onLargePaste={(pasted) => setQuestionText((previous) => previous + pasted)}
              onPasteImage={(allowSystemFallback) => {
                void pasteClipboardImage(allowSystemFallback, false);
              }}
              onRemoveAttachment={() => undefined}
              onSubmit={submitQuestionAnswer}
            />
          </Box>
          <Text dimColor>
            {pendingQuestionOptions.length > 0 ? '↑/↓ choose · Enter send · Esc dismiss' : 'Type an answer · Enter send · Esc dismiss'}
          </Text>
        </Box>
      ) : null}

      {subagentView ? (
        <Box ref={composerSlotRef} width={composerWidth} flexDirection="column" marginBottom={1} flexShrink={0}>
          <Text dimColor>{'─'.repeat(Math.max(1, composerWidth))}</Text>
          <Text dimColor>{`${glyphs.bullet} subagent session · view only · ↑ returns to the parent session`}</Text>
        </Box>
      ) : pending ? (
        <Box ref={composerSlotRef} width={composerWidth} height={COMPOSER_SLOT_HEIGHT} marginBottom={1} flexShrink={0}>
          {/* The rule stays while an approval is open so the transcript does not reflow by a row. */}
          <Text dimColor>{'─'.repeat(Math.max(1, composerWidth))}</Text>
        </Box>
      ) : pendingQuestion ? (
        <Box ref={composerSlotRef} width={composerWidth} marginBottom={1} flexShrink={0} />
      ) : (
        <Box ref={composerSlotRef} width={composerWidth} flexDirection="column" marginBottom={1} flexShrink={0}>
          <Text dimColor={popupOpen}>{'─'.repeat(Math.max(1, composerWidth))}</Text>
          <Box width="100%" flexDirection="row" flexShrink={0}>
            <Text dimColor={popupOpen} {...(popupOpen ? {} : { color: tokens.accent })}>
              {`${glyphs.prompt} `}
            </Text>
            {largePasteContent ? <Text dimColor>[ pasted text ] </Text> : null}
            {imageAttachments.map((_, index) => (
              <Text key={index} dimColor>
                [Image attached #{index + 1}]{' '}
              </Text>
            ))}
            <SessionComposer
              key={composerKey}
              value={composerText}
              disabled={popupOpen}
              placeholder="Type a message…"
              attachmentCount={imageAttachments.length}
              history={inputHistory}
              onChange={handleComposerChange}
              onLargePaste={handleLargePaste}
              onPasteImage={(allowSystemFallback) => {
                void pasteClipboardImage(allowSystemFallback, false);
              }}
              onRemoveAttachment={() => setImageAttachments((images) => images.slice(0, -1))}
              onSubmit={(text) => {
                const outgoing =
                  slashMenuVisible && !largePasteContent && imageAttachments.length === 0
                    ? (slashSuggestions[selectedSlashIndex]?.command ?? text)
                    : text;
                void send(outgoing, imageAttachments);
              }}
            />
          </Box>
        </Box>
      )}
      {queuedMessageCount > 0 && !pending ? (
        <Box position="absolute" top={queuedMessageCardTop} left={0} width="100%" justifyContent="center">
          <Box flexDirection="column" borderStyle="single" borderDimColor backgroundColor={tokens.surface} paddingX={1} flexShrink={0}>
            <Box flexDirection="row" flexShrink={0}>
              <Text color={tokens.accent} bold>
                {`${glyphs.dot} ${queuedCardTitle}`}
              </Text>
              <Text dimColor> · sends on next gap</Text>
            </Box>
            {queuedPreviews.map((preview, index) => (
              <Text key={index} dimColor>
                {`${index + 1}. ${clipped(preview, Math.max(8, width - 12))}`}
              </Text>
            ))}
            {queuedOverflowCount > 0 ? <Text dimColor>{`+${queuedOverflowCount} more…`}</Text> : null}
          </Box>
        </Box>
      ) : null}
      <Box width="100%" flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <Box flexDirection="row" flexShrink={1}>
          {pendingQuestion || pending ? (
            <Text dimColor>{footerHint}</Text>
          ) : busy ? (
            <>
              <RunningIndicator tokens={tokens} />
              <Text dimColor>{` · ${busyHint}`}</Text>
            </>
          ) : null}
        </Box>
        <Text dimColor>{clipped(footerMeta, Math.max(8, composerWidth - terminalTextWidth(footerHint) - 2))}</Text>
      </Box>

      {pending ? (
        <Box ref={approvalPanelRef} position="absolute" top={approvalPanelTop} left={0} width={composerWidth} flexShrink={0}>
          <Box
            width="100%"
            flexDirection="column"
            borderStyle="single"
            borderDimColor
            backgroundColor={tokens.surface}
            paddingX={1}
            flexShrink={0}
          >
            <Box width="100%" flexDirection="row" flexShrink={0}>
              <Text color={tokens.warning} bold>
                {`${glyphs.warn} approval required`}
              </Text>
            </Box>
            <Box ref={commandRef} width="100%" flexShrink={0}>
              <Text>{approvalPreview}</Text>
            </Box>
            {approvalNote ? <Text dimColor>{clipTerminalWidth(approvalNote, Math.max(8, composerWidth - 7))}</Text> : null}
            <Box width="100%" flexDirection="row" marginTop={1} flexShrink={0}>
              {approvalActions.map((action, index) => (
                <Box
                  key={action.decision}
                  ref={(element) => {
                    if (element) approvalButtonRefs.current.set(action.decision, element);
                    else approvalButtonRefs.current.delete(action.decision);
                  }}
                  marginRight={index < approvalActions.length - 1 ? 2 : 0}
                  flexShrink={1}
                >
                  <Text
                    dimColor={approvalSelection !== index}
                    bold={approvalSelection === index}
                    {...(approvalSelection === index ? { color: action.decision === 'deny' ? tokens.error : tokens.accent } : {})}
                  >
                    {approvalSelection === index ? `${glyphs.prompt} ` : ''}
                    {action.label}
                  </Text>
                </Box>
              ))}
            </Box>
            <Text dimColor>
              {approvalContentNeedsExpand
                ? `${mouseInput.supported ? 'Click or ' : ''}Space to ${expandedCommand ? 'collapse' : 'inspect details'}`
                : '←/→ choose · Enter confirm · Esc deny'}
            </Text>
          </Box>
        </Box>
      ) : null}

      {settingsOpen ? (
        <PopupFrame
          tokens={tokens}
          width={Math.max(12, Math.min(64, columns - 8))}
          title="Settings"
          subtitle="Theme"
          hint="↑/↓ move · Enter select · Esc close"
        >
          {themeOptions.map((option, index) => (
            <Box key={option} width="100%" {...(settingsSelection === index ? { backgroundColor: tokens.accent } : {})}>
              <Text {...(settingsSelection === index ? { color: tokens.onAccent } : { color: tokens.accent })}>
                {settingsSelection === index ? `${glyphs.prompt} ` : '  '}
              </Text>
              <Text {...(settingsSelection === index ? { color: tokens.onAccent } : { dimColor: true })}>
                {option}
                {selectedTheme === option ? '  · current' : ''}
              </Text>
            </Box>
          ))}
        </PopupFrame>
      ) : null}
      {permissionsOpen ? (
        <PopupFrame
          tokens={tokens}
          width={Math.max(24, Math.min(64, columns - 8))}
          title="Tool access"
          subtitle={`Choose how OpenButler handles actions outside this workspace.\n${clipped(runtime.workspaceRoot, Math.max(12, Math.min(52, columns - 18)))}`}
          hint="↑/↓ move · Enter select · Esc close"
        >
          {[
            { mode: 'workspace' as const, label: 'Workspace', description: 'Trust this folder; ask before actions outside it.' },
            {
              mode: 'auto-review' as const,
              label: 'Approve for me',
              description: 'Same folder rule; the model reviews outside actions.',
            },
            { mode: 'full-access' as const, label: 'Full access', description: 'Run tools without permission prompts.' },
          ].map((option, index) => (
            <Box
              key={option.mode}
              width="100%"
              flexDirection="column"
              {...(permissionsSelection === index ? { backgroundColor: tokens.accent } : {})}
            >
              <Box width="100%">
                <Text {...(permissionsSelection === index ? { color: tokens.onAccent } : { color: tokens.accent })}>
                  {permissionsSelection === index ? `${glyphs.prompt} ` : '  '}
                </Text>
                <Text {...(permissionsSelection === index ? { color: tokens.onAccent } : { dimColor: true })}>
                  {option.label}
                  {(runtime.approvalMode ?? 'workspace') === option.mode ? '  · current' : ''}
                </Text>
              </Box>
              <Text {...(permissionsSelection === index ? { color: tokens.onAccent } : { dimColor: true })}> {option.description}</Text>
            </Box>
          ))}
        </PopupFrame>
      ) : null}
      {reasoningOpen ? (
        <PopupFrame
          tokens={tokens}
          width={Math.max(12, Math.min(64, columns - 8))}
          title="Reasoning"
          subtitle={`${runtime.providerId}/${runtime.modelId}`}
          hint="↑/↓ move · Enter select · Esc close"
        >
          {runtime.reasoningVariants.length <= 1 ? (
            <Text dimColor>
              {(runtime.reasoningSupport ?? 'model-unsupported') === 'adapter-unmapped'
                ? 'This model lists reasoning support, but OpenButler has no reasoning mapping for this adapter yet.'
                : 'No selectable reasoning variants are listed for this model.'}
            </Text>
          ) : (
            runtime.reasoningVariants.map((variant, index) => (
              <Box key={variant.id} width="100%" {...(reasoningSelection === index ? { backgroundColor: tokens.accent } : {})}>
                <Text {...(reasoningSelection === index ? { color: tokens.onAccent } : { color: tokens.accent })}>
                  {reasoningSelection === index ? `${glyphs.prompt} ` : '  '}
                </Text>
                <Text {...(reasoningSelection === index ? { color: tokens.onAccent } : { dimColor: true })}>
                  {variant.label}
                  {reasoningVariantId === variant.id ? '  · current' : ''}
                </Text>
              </Box>
            ))
          )}
        </PopupFrame>
      ) : null}
      {thinkingOpen ? (
        <PopupFrame
          tokens={tokens}
          width={Math.max(12, Math.min(64, columns - 8))}
          title="Thinking"
          subtitle="Show reasoning above assistant messages (hidden entries are kept)"
          hint="↑/↓ move · Enter select · Esc close"
        >
          {['Off', 'On'].map((option, index) => (
            <Box key={option} width="100%" {...(thinkingSelection === index ? { backgroundColor: tokens.accent } : {})}>
              <Text {...(thinkingSelection === index ? { color: tokens.onAccent } : { color: tokens.accent })}>
                {thinkingSelection === index ? `${glyphs.prompt} ` : '  '}
              </Text>
              <Text {...(thinkingSelection === index ? { color: tokens.onAccent } : { dimColor: true })}>
                {option}
                {showReasoning === (index === 1) ? '  · current' : ''}
              </Text>
            </Box>
          ))}
        </PopupFrame>
      ) : null}
      {providerOpen ? (
        <ProviderPicker
          mode={providerPickerMode}
          currentProviderId={runtime.providerId}
          currentModelId={runtime.modelId}
          onClose={() => setProviderOpen(false)}
          onSelectModel={applyProviderModel}
          tokens={tokens}
        />
      ) : null}
      {sessionChooserOpen ? (
        <PopupFrame
          tokens={tokens}
          width={Math.max(24, Math.min(72, columns - 8))}
          title="Sessions"
          hint="↑/↓ select · Type to search · Enter open · Esc close"
        >
          <Box width="100%">
            <Text color={tokens.accent}>{`${glyphs.prompt} `}</Text>
            <Text dimColor={!sessionSearch}>{sessionSearch || 'Type to filter sessions'}</Text>
          </Box>
          <Box height={1} flexShrink={0} />
          {filteredSessions.length === 0 ? <Text dimColor>No saved sessions match this search.</Text> : null}
          <Box flexDirection="column" width="100%">
            {visibleSessionChoices.map((choice, offset) => {
              const index = sessionListStart + offset;
              const selected = selectedSessionIndex === index;
              if (choice.kind === 'new') {
                return (
                  <Box key="new-session" flexDirection="column" width="100%" {...(selected ? { backgroundColor: tokens.accent } : {})}>
                    <Box width="100%">
                      <Text {...(selected ? { color: tokens.onAccent } : { color: tokens.accent })}>
                        {selected ? `${glyphs.prompt} ` : '  '}
                      </Text>
                      <Text {...(selected ? { color: tokens.onAccent } : { dimColor: true })}>New session</Text>
                    </Box>
                    <Text {...(selected ? { color: tokens.onAccent } : { dimColor: true })}>Start a blank conversation</Text>
                  </Box>
                );
              }
              const session = choice.session;
              const updatedAt = new Date(session.updatedAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
              return (
                <Box key={session.id} flexDirection="column" width="100%" {...(selected ? { backgroundColor: tokens.accent } : {})}>
                  <Box width="100%">
                    <Text {...(selected ? { color: tokens.onAccent } : { color: tokens.accent })}>
                      {selected ? `${glyphs.prompt} ` : '  '}
                    </Text>
                    <Text {...(selected ? { color: tokens.onAccent } : { dimColor: true })}>
                      {session.title}
                      {session.id === activeSession.id ? '  · current' : ''}
                    </Text>
                  </Box>
                  <Text {...(selected ? { color: tokens.onAccent } : { dimColor: true })}>
                    {clipped(session.preview || `${session.providerId}/${session.modelId}`, 64)} · {updatedAt}
                  </Text>
                </Box>
              );
            })}
          </Box>
        </PopupFrame>
      ) : null}

      {sessionSaveError || composerNotice || escapeWarning ? (
        <Box position="absolute" top={0} left={0} width="100%" justifyContent="center">
          <Box flexDirection="column" backgroundColor={tokens.surface} paddingX={1} flexShrink={0}>
            {sessionSaveError ? <Text color={tokens.error}>Session auto-save failed: {clipped(sessionSaveError, 120)}</Text> : null}
            {composerNotice ? <Text color={tokens.warning}>{composerNotice}</Text> : null}
            {!composerNotice && escapeWarning ? <Text color={tokens.warning}>{escapeWarning}</Text> : null}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function ProviderPicker({
  mode,
  currentProviderId,
  currentModelId,
  onClose,
  onSelectModel,
  tokens,
}: {
  mode: 'provider' | 'models';
  currentProviderId: string;
  currentModelId: string;
  onClose: () => void;
  onSelectModel: (providerId: string, modelId: string) => Promise<void>;
  tokens: UiTokens;
}) {
  const { columns, rows } = useWindowSize();
  const [step, setStep] = useState<'providers' | 'custom-id' | 'custom-runtime' | 'custom-url' | 'key' | 'models'>(
    mode === 'models' ? 'models' : 'providers',
  );
  const [providers, setProviders] = useState<ProviderChoice[]>([]);
  const [providerSearch, setProviderSearch] = useState('');
  const [providerSelection, setProviderSelection] = useState(0);
  const [providerId, setProviderId] = useState('');
  const [providerName, setProviderName] = useState('');
  const [providerKey, setProviderKey] = useState('');
  const [customProviderId, setCustomProviderId] = useState('');
  const [customEndpointUrl, setCustomEndpointUrl] = useState('');
  const [customRuntime, setCustomRuntime] = useState(listSupportedPackages()[0] ?? '');
  const [customRuntimeSelection, setCustomRuntimeSelection] = useState(0);
  const [customDraft, setCustomDraft] = useState(false);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [modelSelection, setModelSelection] = useState(0);
  const [manualModelOpen, setManualModelOpen] = useState(false);
  const [manualModelId, setManualModelId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const runtimePackages = listSupportedPackages();

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        try {
          await getCatalogIndex();
        } catch (reason) {
          if (mounted) setError(reason instanceof Error ? reason.message : String(reason));
        }
        if (mode === 'models') {
          const settings = loadSettings();
          const configuredProviders = Object.keys(settings.providers).filter((id) => settings.providers[id]?.enabled);
          const available: ModelChoice[] = [];
          const knownChoices = new Set<string>();
          const addModel = (providerId: string, modelId: string) => {
            const key = `${providerId}\0${modelId}`;
            if (!modelId || knownChoices.has(key)) return;
            knownChoices.add(key);
            available.push({ providerId, modelId, name: resolveModelName(providerId, modelId, settings) });
          };
          for (const entry of listCatalogModels(configuredProviders)) {
            addModel(entry.providerId, entry.model);
          }
          for (const providerId of configuredProviders) {
            for (const modelId of settings.providers[providerId]?.models ?? []) addModel(providerId, modelId);
          }
          const customProviders = new Set(configuredProviders.filter((id) => !getProvider(id) && Boolean(settings.providers[id]?.npm)));
          for (const session of listSavedSessions()) {
            if (customProviders.has(session.providerId)) addModel(session.providerId, session.modelId);
          }
          if (settings.defaultProvider && settings.providers[settings.defaultProvider]?.enabled) {
            addModel(settings.defaultProvider, settings.defaultModel);
          }
          if (currentProviderId) addModel(currentProviderId, currentModelId);
          available.sort((left, right) => left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId));
          if (mounted) {
            setModels(available);
            setModelSelection(
              Math.max(
                0,
                available.findIndex((entry) => entry.providerId === currentProviderId && entry.modelId === currentModelId),
              ),
            );
            setStep('models');
          }
          return;
        }
        const catalogOptions = listProviderSummaries()
          .flatMap((entry): ProviderChoice[] => {
            const provider = getProvider(entry.id);
            if (!provider?.npm) return [];
            return [{ kind: 'catalog', id: entry.id, name: provider.name ?? entry.id, modelCount: entry.modelCount }];
          })
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
        const settings = loadSettings();
        const customOptions = Object.entries(settings.providers)
          .flatMap(([id, state]): ProviderChoice[] => {
            if (getProvider(id) || !state.npm) return [];
            return [{ kind: 'custom', id, name: id, modelCount: 0 }];
          })
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
        if (mounted)
          setProviders([
            ...catalogOptions,
            ...customOptions,
            { kind: 'add-custom', id: '__add_custom_endpoint__', name: 'Add a custom endpoint…', modelCount: 0 },
          ]);
      } catch (reason) {
        if (mounted) setError(reason instanceof Error ? reason.message : String(reason));
        if (mode === 'models' && mounted) {
          setModels(currentProviderId && currentModelId ? [{ providerId: currentProviderId, modelId: currentModelId }] : []);
          setStep('models');
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [currentModelId, currentProviderId, mode]);

  const normalizedProviderSearch = providerSearch.trim().toLocaleLowerCase('en-US');
  const filteredProviders = providers.filter(
    (provider) =>
      provider.kind === 'add-custom' || `${provider.name} ${provider.id}`.toLocaleLowerCase('en-US').includes(normalizedProviderSearch),
  );
  const normalizedModelSearch = modelSearch.trim().toLocaleLowerCase('en-US');
  const filteredModels = models.filter((model) =>
    `${getProvider(model.providerId)?.name ?? model.providerId} ${model.providerId} ${model.modelId} ${model.name ?? ''}`
      .toLocaleLowerCase('en-US')
      .includes(normalizedModelSearch),
  );
  const visibleCount = Math.max(1, Math.min(8, rows - 18));
  const providerIndex = filteredProviders.length === 0 ? 0 : Math.min(providerSelection, filteredProviders.length - 1);
  const providerStart = Math.max(0, Math.min(providerIndex - visibleCount + 1, filteredProviders.length - visibleCount));
  const visibleProviders = filteredProviders.slice(providerStart, providerStart + visibleCount);
  const modelChoiceCount = filteredModels.length + 1;
  const modelIndex = Math.min(modelSelection, modelChoiceCount - 1);
  const modelStart = Math.max(0, Math.min(modelIndex - visibleCount + 1, modelChoiceCount - visibleCount));

  const loadProviderModels = useCallback(async () => {
    if (!providerId) return;
    setLoading(true);
    setError(null);
    try {
      const settings = loadSettings();
      const configured = settings.providers[providerId];
      const key = providerKey.trim();
      if (!key && !providerIsConfigured(providerId, configured)) {
        setError(
          'Needs a credential: paste an API key, or set providers.' + providerId + '.options / its environment variables in settings.yaml.',
        );
        setLoading(false);
        return;
      }
      if (key) {
        upsertProvider(settings, providerId, {
          enabled: true,
          keys: [key, ...(configured?.keys ?? []).filter((existing) => existing !== key)],
        });
        writeSettings(settings);
      } else if (configured) {
        upsertProvider(settings, providerId, { enabled: true });
        writeSettings(settings);
      }
      setProviderKey('');
      if (!configured?.npm || getProvider(providerId)) await getCatalogIndex();
      const latest = loadSettings();
      const available: ModelChoice[] = [];
      const knownChoices = new Set<string>();
      const addModel = (modelId: string) => {
        const key = `${providerId}\0${modelId}`;
        if (!modelId || knownChoices.has(key)) return;
        knownChoices.add(key);
        available.push({ providerId, modelId, name: resolveModelName(providerId, modelId, latest) });
      };
      for (const entry of listCatalogModels([providerId])) addModel(entry.model);
      for (const modelId of latest.providers[providerId]?.models ?? []) addModel(modelId);
      if (available.length === 0 && latest.defaultProvider === providerId) addModel(latest.defaultModel);
      setModels(available);
      setModelSearch('');
      setModelSelection(0);
      setStep('models');
      if (available.length === 0 && !configured?.npm) setError(`No models are listed for ${providerName}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [providerId, providerKey, providerName]);

  const saveCustomProvider = useCallback(async () => {
    const key = providerKey.trim();
    if (!key) {
      setError('Enter an API key to continue.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const settings = loadSettings();
      const existing = settings.providers[providerId];
      upsertProvider(settings, providerId, {
        enabled: true,
        keys: [key, ...(existing?.keys ?? []).filter((value) => value !== key)],
        npm: customRuntime,
        url: customEndpointUrl.trim(),
      });
      writeSettings(settings);
      setProviderKey('');
      setHasSavedKey(true);
      setCustomDraft(false);
      setModels([]);
      setModelSearch('');
      setModelSelection(0);
      setStep('models');
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [customEndpointUrl, customRuntime, providerId, providerKey]);

  const chooseModel = useCallback(
    async (choice: ModelChoice) => {
      if (!choice.providerId || !choice.modelId) return;
      setLoading(true);
      setError(null);
      try {
        await onSelectModel(choice.providerId, choice.modelId);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      }
    },
    [onSelectModel],
  );

  usePaste(
    (text) => {
      if (loading) return;
      if (manualModelOpen) {
        setManualModelId(text);
        setError(null);
      } else if (step === 'custom-id') {
        setCustomProviderId(text.trim());
        setError(null);
      } else if (step === 'custom-url') {
        setCustomEndpointUrl(text.trim());
        setError(null);
      } else if (step === 'key') {
        setProviderKey(text);
        setError(null);
      }
    },
    { isActive: (step === 'key' || step === 'custom-id' || step === 'custom-url' || manualModelOpen) && !loading },
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        if (loading) return;
        if (manualModelOpen) {
          setManualModelOpen(false);
          setManualModelId('');
          setError(null);
          return;
        }
        if (step === 'models') {
          if (mode === 'models') onClose();
          else {
            setStep('key');
            setError(null);
          }
        } else if (step === 'key') {
          setProviderKey('');
          setError(null);
          setStep(customDraft ? 'custom-url' : 'providers');
        } else if (step === 'custom-url') {
          setStep('custom-runtime');
          setError(null);
        } else if (step === 'custom-runtime') {
          setStep('custom-id');
          setError(null);
        } else if (step === 'custom-id') {
          setStep('providers');
          setError(null);
        } else onClose();
        return;
      }
      if (loading) return;

      if (manualModelOpen) {
        if (key.return) {
          const modelId = manualModelId.trim();
          if (!modelId) {
            setError('Enter a model ID.');
            return;
          }
          void chooseModel({ providerId: mode === 'models' ? currentProviderId : providerId, modelId });
        } else if (key.backspace || key.delete) {
          setManualModelId((value) => value.slice(0, -1));
        } else if (key.ctrl && input.toLowerCase() === 'u') {
          setManualModelId('');
        } else if (input && !key.ctrl && !key.meta && !key.super && !key.hyper) {
          setManualModelId((value) => value + input);
        }
        return;
      }

      if (step === 'providers') {
        if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
          if (filteredProviders.length === 0) return;
          const delta = key.pageUp ? -visibleCount : key.pageDown ? visibleCount : key.downArrow ? 1 : -1;
          setProviderSelection((index) => Math.max(0, Math.min(filteredProviders.length - 1, index + delta)));
        } else if (key.return) {
          const selected = filteredProviders[providerIndex];
          if (!selected) return;
          if (selected.kind === 'add-custom') {
            setCustomProviderId('');
            setCustomEndpointUrl('');
            setCustomRuntime(runtimePackages[0] ?? '');
            setCustomRuntimeSelection(0);
            setCustomDraft(true);
            setError(null);
            setStep('custom-id');
            return;
          }
          const existing = loadSettings().providers[selected.id];
          setProviderId(selected.id);
          setProviderName(selected.name);
          setProviderKey('');
          setHasSavedKey(Boolean(existing?.keys.some(Boolean)));
          setCustomEndpointUrl(existing?.url ?? '');
          setCustomRuntime(existing?.npm ?? '');
          setCustomDraft(false);
          setError(null);
          setStep('key');
        } else if (key.backspace || key.delete) {
          setProviderSearch((value) => value.slice(0, -1));
          setProviderSelection(0);
        } else if (key.ctrl && input.toLowerCase() === 'u') {
          setProviderSearch('');
          setProviderSelection(0);
        } else if (input && !key.ctrl && !key.meta && !key.super && !key.hyper) {
          setProviderSearch((value) => value + input);
          setProviderSelection(0);
        }
        return;
      }

      if (step === 'custom-id') {
        if (key.return) {
          const id = customProviderId.trim();
          if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id)) {
            setError('Use 1–64 letters, digits, or dashes; start with a letter or digit.');
            return;
          }
          if (loadSettings().providers[id] || getProvider(id)) {
            setError('That provider already exists. Select it from the provider list.');
            return;
          }
          setProviderId(id);
          setProviderName(id);
          setError(null);
          setStep('custom-runtime');
        } else if (key.backspace || key.delete) {
          setCustomProviderId((value) => value.slice(0, -1));
        } else if (key.ctrl && input.toLowerCase() === 'u') {
          setCustomProviderId('');
        } else if (input && !key.ctrl && !key.meta && !key.super && !key.hyper) {
          setCustomProviderId((value) => value + input);
        }
        return;
      }

      if (step === 'custom-runtime') {
        if (key.upArrow || key.downArrow) {
          setCustomRuntimeSelection((index) => (index + (key.downArrow ? 1 : -1) + runtimePackages.length) % runtimePackages.length);
        } else if (key.return && runtimePackages[customRuntimeSelection]) {
          setCustomRuntime(runtimePackages[customRuntimeSelection]!);
          setError(null);
          setStep('custom-url');
        }
        return;
      }

      if (step === 'custom-url') {
        if (key.return) {
          let valid = false;
          try {
            const endpoint = new URL(customEndpointUrl.trim());
            valid =
              (endpoint.protocol === 'https:' || endpoint.protocol === 'http:') &&
              Boolean(endpoint.hostname) &&
              !endpoint.username &&
              !endpoint.password;
          } catch {
            valid = false;
          }
          if (!valid) {
            setError('Enter a valid HTTP or HTTPS endpoint URL.');
            return;
          }
          setProviderKey('');
          setHasSavedKey(false);
          setError(null);
          setStep('key');
        } else if (key.backspace || key.delete) {
          setCustomEndpointUrl((value) => value.slice(0, -1));
        } else if (key.ctrl && input.toLowerCase() === 'u') {
          setCustomEndpointUrl('');
        } else if (input && !key.ctrl && !key.meta && !key.super && !key.hyper) {
          setCustomEndpointUrl((value) => value + input);
        }
        return;
      }

      if (step === 'key') {
        if (key.return) {
          if (customDraft) void saveCustomProvider();
          else void loadProviderModels();
        } else if (key.backspace || key.delete) {
          setProviderKey((value) => value.slice(0, -1));
        } else if (key.ctrl && input.toLowerCase() === 'u') {
          setProviderKey('');
        } else if (input && !key.ctrl && !key.meta && !key.super && !key.hyper) {
          setProviderKey((value) => value + input);
        }
        return;
      }

      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
        if (modelChoiceCount === 0) return;
        const delta = key.pageUp ? -visibleCount : key.pageDown ? visibleCount : key.downArrow ? 1 : -1;
        setModelSelection((index) => Math.max(0, Math.min(modelChoiceCount - 1, index + delta)));
      } else if (key.return) {
        const model = filteredModels[modelIndex];
        if (modelIndex === filteredModels.length) {
          setManualModelId('');
          setManualModelOpen(true);
          setError(null);
        } else if (model) void chooseModel(model);
      } else if (key.backspace || key.delete) {
        setModelSearch((value) => value.slice(0, -1));
        setModelSelection(0);
      } else if (key.ctrl && input.toLowerCase() === 'u') {
        setModelSearch('');
        setModelSelection(0);
      } else if (input && !key.ctrl && !key.meta && !key.super && !key.hyper) {
        setModelSearch((value) => value + input);
        setModelSelection(0);
      }
    },
    { isActive: true },
  );

  const panelWidth = Math.max(28, Math.min(76, columns - 8));
  // One header per wizard step: the shared frame prints title, subtitle, and
  // hint with breathing room, so each step only renders its own content.
  const stepMeta = {
    providers: {
      title: 'Providers',
      subtitle: 'Choose a provider from the models.dev catalog.',
      hint: '↑/↓ or PgUp/PgDn · Type to search · Enter select · Esc close',
    },
    'custom-id': {
      title: 'Custom provider',
      subtitle: 'Choose a unique provider ID using letters, digits, or dashes.',
      hint: 'Enter continue · Esc providers',
    },
    'custom-runtime': {
      title: providerName,
      subtitle: 'Choose the AI SDK runtime package for this endpoint.',
      hint: '↑/↓ choose · Enter continue · Esc back',
    },
    'custom-url': {
      title: providerName,
      subtitle: 'Enter the endpoint base URL (for example, https://host/v1).',
      hint: 'Enter continue · Esc back',
    },
    key: {
      title: providerName,
      subtitle: 'Paste this provider’s API key. The key is stored in OpenButler settings.',
      hint: customDraft ? 'Enter save · Esc endpoint' : 'Enter continue · Esc providers',
    },
    models: {
      title: mode === 'models' ? 'Models' : `${providerName} models`,
      subtitle: mode === 'models' ? 'Models from configured providers' : undefined,
      hint: manualModelOpen ? 'Enter select · Esc back' : '↑/↓ or PgUp/PgDn · Type to search · Enter select · Esc back',
    },
  }[step];
  return (
    <PopupFrame tokens={tokens} width={panelWidth} title={stepMeta.title} subtitle={stepMeta.subtitle} hint={stepMeta.hint}>
      {step === 'providers' ? (
        <>
          <Box width="100%">
            <Text color={tokens.accent}>{`${glyphs.prompt} `}</Text>
            <Text dimColor={!providerSearch}>{providerSearch || 'Type to filter providers'}</Text>
          </Box>
          {loading ? <Text dimColor>Loading providers…</Text> : null}
          {!loading && filteredProviders.length === 0 ? <Text dimColor>No matching providers.</Text> : null}
          <Box flexDirection="column" width="100%">
            {visibleProviders.map((provider, offset) => {
              const index = providerStart + offset;
              const selected = index === providerIndex;
              return (
                <Box key={provider.id} width="100%" {...(selected ? { backgroundColor: tokens.accent } : {})}>
                  <Text {...(selected ? { color: tokens.onAccent } : { color: tokens.accent })}>
                    {selected ? `${glyphs.prompt} ` : '  '}
                  </Text>
                  <Text {...(selected ? { color: tokens.onAccent } : { dimColor: true })}>
                    {provider.kind === 'add-custom'
                      ? provider.name
                      : provider.kind === 'custom'
                        ? `${provider.name} (${provider.id}) · custom endpoint${provider.id === currentProviderId ? ' · current' : ''}`
                        : `${provider.name} (${provider.id}) · ${provider.modelCount} models${provider.id === currentProviderId ? ' · current' : ''}`}
                  </Text>
                </Box>
              );
            })}
          </Box>
          {error ? <Text color={tokens.error}>{clipped(error, panelWidth - 6)}</Text> : null}
        </>
      ) : null}

      {step === 'custom-id' ? (
        <>
          <Box width="100%">
            <Text color={tokens.accent}>{`${glyphs.prompt} `}</Text>
            <Text dimColor>Provider ID </Text>
            <Text dimColor={!customProviderId}>{customProviderId || 'Type a provider ID'}</Text>
          </Box>
          {error ? <Text color={tokens.error}>{clipped(error, panelWidth - 6)}</Text> : null}
        </>
      ) : null}

      {step === 'custom-runtime' ? (
        <>
          {runtimePackages.map((name, index) => (
            <Box key={name} width="100%" {...(index === customRuntimeSelection ? { backgroundColor: tokens.accent } : {})}>
              <Text {...(index === customRuntimeSelection ? { color: tokens.onAccent } : { color: tokens.accent })}>
                {index === customRuntimeSelection ? `${glyphs.prompt} ` : '  '}
              </Text>
              <Text {...(index === customRuntimeSelection ? { color: tokens.onAccent } : { dimColor: true })}>{name}</Text>
            </Box>
          ))}
        </>
      ) : null}

      {step === 'custom-url' ? (
        <>
          <Box width="100%">
            <Text color={tokens.accent}>{`${glyphs.prompt} `}</Text>
            <Text dimColor>URL </Text>
            <Text dimColor={!customEndpointUrl}>{customEndpointUrl || 'Type or paste a URL'}</Text>
          </Box>
          {error ? <Text color={tokens.error}>{clipped(error, panelWidth - 6)}</Text> : null}
        </>
      ) : null}

      {step === 'key' ? (
        <>
          {hasSavedKey ? <Text dimColor>Press Enter to keep the saved key.</Text> : null}
          <Box width="100%">
            <Text color={tokens.accent}>{`${glyphs.prompt} `}</Text>
            <Text dimColor>API key </Text>
            <Text dimColor={!providerKey}>
              {providerKey ? `${'•'.repeat(Math.min(providerKey.length, 48))}${providerKey.length > 48 ? '…' : ''}` : 'Paste key here'}
            </Text>
          </Box>
          {error ? <Text color={tokens.error}>{clipped(error, panelWidth - 6)}</Text> : null}
        </>
      ) : null}

      {step === 'models' ? (
        <>
          <Box width="100%">
            <Text color={tokens.accent}>{`${glyphs.prompt} `}</Text>
            <Text dimColor={!modelSearch}>{modelSearch || 'Type to filter models'}</Text>
          </Box>
          {loading ? <Text dimColor>Loading models…</Text> : null}
          {!loading && filteredModels.length === 0 ? <Text dimColor>No catalog models. Enter a model ID below.</Text> : null}
          <Box flexDirection="column" width="100%">
            {Array.from({ length: Math.min(visibleCount, modelChoiceCount - modelStart) }, (_, offset) => {
              const index = modelStart + offset;
              const selected = index === modelIndex;
              const model = filteredModels[index];
              const enterModelId = index === filteredModels.length;
              return (
                <Box
                  key={enterModelId ? 'enter-model-id' : `${model?.providerId}/${model?.modelId}`}
                  width="100%"
                  {...(selected ? { backgroundColor: tokens.accent } : {})}
                >
                  <Text {...(selected ? { color: tokens.onAccent } : { color: tokens.accent })}>
                    {selected ? `${glyphs.prompt} ` : '  '}
                  </Text>
                  <Text {...(selected ? { color: tokens.onAccent } : { dimColor: true })}>
                    {enterModelId ? 'Enter model ID…' : `${model?.providerId} / ${model?.name ?? model?.modelId}`}
                    {!enterModelId && model?.providerId === currentProviderId && model.modelId === currentModelId ? ' · current' : ''}
                  </Text>
                </Box>
              );
            })}
          </Box>
          {manualModelOpen ? (
            <Box width="100%">
              <Text color={tokens.accent}>{`${glyphs.prompt} `}</Text>
              <Text dimColor>Model ID </Text>
              <Text dimColor={!manualModelId}>{manualModelId || 'Type or paste a model ID'}</Text>
            </Box>
          ) : null}
          {error ? <Text color={tokens.error}>{clipped(error, panelWidth - 6)}</Text> : null}
        </>
      ) : null}
    </PopupFrame>
  );
}

function SessionComposer({
  value,
  disabled,
  placeholder,
  attachmentCount,
  history = [],
  onChange,
  onLargePaste,
  onPasteImage,
  onRemoveAttachment,
  onSubmit,
}: {
  value: string;
  disabled: boolean;
  placeholder: string;
  attachmentCount: number;
  /** Submitted inputs, oldest first, for up/down recall. */
  history?: string[];
  onChange: (value: string) => void;
  onLargePaste: (value: string) => void;
  onPasteImage: (allowSystemFallback: boolean) => void;
  onRemoveAttachment: () => void;
  onSubmit: (value: string) => void;
}) {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  /** Position in `history` while recalling; -1 means "editing the live draft". */
  const [historyIndex, setHistoryIndex] = useState(-1);
  const insertText = useCallback(
    (text: string) => {
      const nextValue = value.slice(0, cursorOffset) + text + value.slice(cursorOffset);
      if (Buffer.byteLength(nextValue, 'utf8') > MAX_PASTED_TEXT_BYTES) {
        onLargePaste(nextValue);
        return;
      }
      setHistoryIndex(-1);
      setCursorOffset(cursorOffset + text.length);
      onChange(nextValue);
    },
    [cursorOffset, onChange, onLargePaste, value],
  );

  usePaste(
    (text) => {
      if (text) insertText(text);
      onPasteImage(text.length === 0);
    },
    { isActive: !disabled },
  );

  useInput(
    (input, key) => {
      if (disabled || key.tab || (key.shift && key.tab) || key.meta || key.super || key.hyper) return;
      // Up/down recall previously submitted inputs (shell history), before any
      // other handling, so a bare arrow never reaches the transcript scroller.
      if (key.upArrow || key.downArrow) {
        if (history.length === 0) return;
        const previous = key.upArrow;
        const next = previous ? (historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)) : historyIndex + 1;
        if (next < 0 || next >= history.length) {
          setHistoryIndex(-1);
          setCursorOffset(0);
          onChange('');
          return;
        }
        const recalled = history[next]!;
        setHistoryIndex(next);
        setCursorOffset(recalled.length);
        onChange(recalled);
        return;
      }
      // Readline basics live here so they never reach the transcript scroller.
      if (key.ctrl && input.toLowerCase() === 'u') {
        setHistoryIndex(-1);
        onChange('');
        setCursorOffset(0);
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'a') {
        setCursorOffset(0);
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'e') {
        setCursorOffset(value.length);
        return;
      }
      if (key.ctrl) return;
      if (key.home) {
        setCursorOffset(0);
        return;
      }
      if (key.end) {
        setCursorOffset(value.length);
        return;
      }
      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.leftArrow) {
        setCursorOffset(previousCharacterStart(value, cursorOffset));
        return;
      }
      if (key.rightArrow) {
        const codePoint = value.codePointAt(cursorOffset);
        if (codePoint !== undefined) setCursorOffset(cursorOffset + (codePoint > 0xffff ? 2 : 1));
        return;
      }
      if (key.backspace) {
        setHistoryIndex(-1);
        const start = previousCharacterStart(value, cursorOffset);
        if (start !== cursorOffset) {
          onChange(value.slice(0, start) + value.slice(cursorOffset));
          setCursorOffset(start);
          return;
        }
        if (cursorOffset === 0 && attachmentCount > 0) onRemoveAttachment();
        return;
      }
      if (key.delete) {
        setHistoryIndex(-1);
        const codePoint = value.codePointAt(cursorOffset);
        const end = codePoint === undefined ? cursorOffset : cursorOffset + (codePoint > 0xffff ? 2 : 1);
        if (end !== cursorOffset) onChange(value.slice(0, cursorOffset) + value.slice(end));
        return;
      }
      if (!input) return;
      insertText(input);
    },
    { isActive: !disabled },
  );

  if (disabled) return <Text>{value}</Text>;
  if (!value) {
    return (
      <Text>
        <Text inverse>{placeholder[0] ?? ' '}</Text>
        <Text dimColor>{placeholder.slice(1)}</Text>
      </Text>
    );
  }

  const offset = Math.min(cursorOffset, value.length);
  const codePoint = value.codePointAt(offset);
  const cursor = codePoint === undefined ? ' ' : String.fromCodePoint(codePoint);
  const cursorLength = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
  return (
    <Text>
      {value.slice(0, offset)}
      <Text inverse>{cursor}</Text>
      {value.slice(offset + (codePoint === undefined ? 0 : cursorLength))}
    </Text>
  );
}

function previousCharacterStart(value: string, offset: number): number {
  const previous = Math.max(0, Math.min(value.length, offset) - 1);
  return previous > 0 && value.charCodeAt(previous) >= 0xdc00 && value.charCodeAt(previous) <= 0xdfff ? previous - 1 : previous;
}

function displayableCommand(command: string): string {
  return command.replace(
    /[\u0000-\u0009\u000b-\u001f\u007f]/g,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

/** A tool entry that is a `subagent` call, or null. */
function subagentCall(entry: Entry | undefined): Extract<Entry, { kind: 'tool' }> | null {
  if (!entry || entry.kind !== 'tool') return null;
  if (entry.tool !== undefined) return entry.tool === 'host:subagent' ? entry : null;
  return /^subagent (explorer|executor)\b/.test(toolEntryCommand(entry)) ? entry : null;
}

/** The worker session id from a subagent-family entry: the entry field first, then the legacy JSON result. */
function subagentWorkerSessionId(entry: Extract<Entry, { kind: 'tool' }>): string | null {
  if (typeof entry.session === 'string' && entry.session) return entry.session;
  try {
    const parsed: unknown = JSON.parse(entry.result);
    if (parsed && typeof parsed === 'object' && 'session' in parsed && typeof (parsed as { session?: unknown }).session === 'string')
      return (parsed as { session: string }).session;
  } catch {
    /* results that are not JSON cannot carry a worker id */
  }
  return null;
}

function toolActivity(entry: Extract<Entry, { kind: 'tool' }>): { active: boolean; label: string } {
  if (entry.running) return { active: true, label: 'running' };
  if (entry.preparing) return { active: true, label: 'preparing' };
  return { active: false, label: '' };
}

function toolCommandReserve(entry: Extract<Entry, { kind: 'tool' }>): number {
  const activity = toolActivity(entry);
  return activity.active ? activity.label.length + 11 : 6;
}

function toolNeedsExpand(entry: Extract<Entry, { kind: 'tool' }>, width: number): boolean {
  const command = displayableCommand(toolEntryCommand(entry)).replace(/\n/g, ' ↵ ');
  const result = displayableCommand(entry.result).trimEnd();
  const outputLines = result.split(/\r?\n/);
  const contentWidth = Math.max(8, width - toolCommandReserve(entry));
  return (
    entry.input !== undefined ||
    terminalTextWidth(command) > contentWidth ||
    result.length > 320 ||
    outputLines.length > 3 ||
    outputLines.some((line) => terminalTextWidth(line) > contentWidth)
  );
}

function userMessageNeedsExpand(entry: Extract<Entry, { kind: 'user' }>): boolean {
  return entry.text.length > 1_200;
}

function toolOutputPreview(result: string, width: number): string {
  const lines = result.split(/\r?\n/);
  const visible = lines.slice(0, 3).map((line) => clipTerminalWidth(line, width));
  const hasMore = lines.length > visible.length || lines.slice(0, visible.length).some((line) => terminalTextWidth(line) > width);
  if (hasMore) visible.push('…');
  return visible.join('\n');
}

/** Severity mark for a notice row: info stays a dim dot, warn/error get their own glyph and color. */
function noticeMark(tone: NoticeTone | undefined, tokens: UiTokens): { glyph: string; color?: string } {
  if (tone === 'error') return { glyph: glyphs.error, color: tokens.error };
  if (tone === 'warn') return { glyph: glyphs.warn, color: tokens.warning };
  return { glyph: glyphs.dot };
}

/** A compaction row has no text of its own: its state and sizes are the message. */
function compactionLabel(entry: { status?: 'running' | 'done' | 'failed'; beforeTokens?: number; afterTokens?: number }): string {
  const label =
    entry.status === 'done' ? 'Context compacted' : entry.status === 'failed' ? 'Compaction interrupted' : 'Compacting context…';
  const size = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));
  if (entry.beforeTokens !== undefined && entry.afterTokens !== undefined) {
    return `${label} (${size(entry.beforeTokens)} → ${size(entry.afterTokens)})`;
  }
  return label;
}

/**
 * Shared frame for every centered popup: one width rule, roomy padding, and a
 * blank row between the title block, the content, and the hint footer, so
 * popups stop reading as a single stuck-together block.
 */
function PopupFrame({
  tokens,
  width,
  title,
  subtitle,
  hint,
  children,
}: {
  tokens: UiTokens;
  width: number;
  title: string;
  subtitle?: string | undefined;
  hint: string;
  children: ReactNode;
}) {
  return (
    <Box position="absolute" top={0} left={0} width="100%" height="100%" justifyContent="center" alignItems="center">
      <Box width={width} flexDirection="column" backgroundColor={tokens.surface} paddingX={2} paddingY={1} flexShrink={0}>
        <Text bold>{title}</Text>
        {subtitle ? <Text dimColor>{subtitle}</Text> : null}
        <Box height={1} flexShrink={0} />
        {children}
        <Box height={1} flexShrink={0} />
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  );
}

function lowerBoundTranscriptRow(offsets: number[], heights: number[], y: number): number {
  let low = 0;
  let high = heights.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle]! + heights[middle]! <= y) low = middle + 1;
    else high = middle;
  }
  return low;
}

function formatThoughtDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function transcriptEntryLayoutKey(
  width: number,
  expandedTool: boolean,
  expandedMessage: boolean,
  expandedNotice: boolean,
  mouseSupported: boolean,
  streaming: boolean,
  reasoningHidden = false,
  reasoningToggled = false,
): string {
  return `${width}:${expandedTool ? 'tool-expanded' : 'tool-normal'}:${expandedMessage ? 'message-expanded' : 'message-normal'}:${expandedNotice ? 'notice-expanded' : 'notice-normal'}:${mouseSupported}:${streaming ? 'streaming' : 'complete'}:${reasoningHidden ? 'reasoning-hidden' : 'reasoning-shown'}:${reasoningToggled ? 'reasoning-toggled' : 'reasoning-default'}`;
}

/**
 * The row span of one entry that can actually be seen. An entry taller than the
 * viewport can never show more than this, and everything outside it is clipped
 * by the frame, so laying out the rest of its text is pure cost.
 */
export interface RowWindow {
  top: number;
  bottom: number;
}

/** Rows each line occupies, by the same rule the height estimator uses. */
function lineRowCounts(text: string, availableWidth: number): number[] {
  return text.split('\n').map((line) => Math.max(1, Math.ceil(terminalTextWidth(line) / Math.max(1, availableWidth))));
}

/**
 * The lines covering a row window, plus how many rows are skipped above and
 * below them. The skipped rows are rendered as fixed-height spacers, so the
 * entry keeps exactly the height the estimator gave it and the viewport shows
 * the same rows it would show with the whole text laid out.
 */
export function sliceTextRows(
  text: string,
  availableWidth: number,
  window: RowWindow,
): { text: string; headRows: number; tailRows: number } {
  const lines = text.split('\n');
  const rows = lineRowCounts(text, availableWidth);
  const prefix: number[] = [0];
  for (const row of rows) prefix.push(prefix.at(-1)! + row);
  const total = prefix.at(-1)!;
  let first = 0;
  while (first < rows.length && prefix[first + 1]! <= window.top) first++;
  let last = rows.length - 1;
  while (last > first && prefix[last]! >= window.bottom) last--;
  if (first >= lines.length) return { text: '', headRows: total, tailRows: 0 };
  const headRows = prefix[first]!;
  const tailRows = Math.max(0, total - prefix[last + 1]!);
  return { text: lines.slice(first, last + 1).join('\n'), headRows, tailRows };
}

export function estimateTranscriptEntryHeight(
  entry: Entry,
  width: number,
  expandedTool = false,
  expandedUser = false,
  expandedNotice = false,
  mouseSupported = true,
  reasoningHidden = false,
  reasoningToggled = false,
): number {
  const wrappedRows = (text: string, availableWidth: number) =>
    text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(terminalTextWidth(line) / Math.max(1, availableWidth))), 0);
  if (entry.kind === 'user') {
    const fullMessage = expandedUser || !mouseSupported;
    const message = fullMessage ? entry.text : clipped(entry.text, 1_200);
    // The expand marker rides inside the message text; it costs no extra row.
    return wrappedRows(message, width - 2) + (entry.imageCount ?? 0) + 1;
  }
  if (entry.kind === 'assistant') {
    const text = entry.text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
    const blocks = Math.max(1, text.split(/\n[ \t]*\n+/).length);
    return wrappedRows(text, width - 2) + blocks + 1;
  }
  if (entry.kind === 'reasoning') {
    // The header row ("Thought for 13.2s") is always drawn, so a collapsed block
    // costs one row plus its margin instead of vanishing from the layout.
    const text = entry.text
      .replace(/\r\n?/g, '\n')
      .replace(/\n[ \t]*\n+/g, '\n')
      .trim();
    if (!text) return 0;
    // A hand toggle flips the global setting for this one block, in both
    // directions: it opens a hidden block and folds a visible one.
    const bodyVisible = reasoningToggled ? reasoningHidden : !reasoningHidden;
    return 1 + (bodyVisible ? wrappedRows(text, width) : 0) + 1;
  }
  if (entry.kind === 'tool') {
    const showFullDetails = expandedTool || !mouseSupported;
    const command = displayableCommand(showFullDetails ? toolEntryDetails(entry) : toolEntryCommand(entry));
    if (toolActivity(entry).active)
      return (
        wrappedRows(
          showFullDetails ? command : clipTerminalWidth(command.replace(/\n/g, ' ↵ '), width - toolCommandReserve(entry)),
          width - 2,
        ) + 1
      );
    const result = displayableCommand(entry.result).trimEnd();
    const preview = showFullDetails ? result : toolOutputPreview(result, width - 6);
    return (
      wrappedRows(showFullDetails ? command : clipTerminalWidth(command.replace(/\n/g, ' ↵ '), width - 6), width - 2) +
      (preview ? wrappedRows(preview, width - 4) + 1 : 0) +
      1
    );
  }
  const noticeText = entry.kind === 'compaction' ? compactionLabel(entry) : dividerLabel(entry);
  if (entry.kind === 'notice' && entry.detail) {
    const showDetail = expandedNotice || !mouseSupported;
    return wrappedRows(clipped(noticeText, 1_200), width - 2) + (showDetail ? wrappedRows(entry.detail, width - 4) : 0) + 1;
  }
  return wrappedRows(clipped(noticeText, 1_200), width - 2) + 1;
}

function renderToolResultText(tool: string | undefined, text: string, dimmed: boolean, tokens: UiTokens): ReactNode {
  if ((tool === 'host:file_write' || tool === 'host:file_edit') && !dimmed) {
    const match = /^\(\+(\d+) -(\d+)\)$/.exec(text.trim());
    if (match) {
      return (
        <Text>
          <Text dimColor>(</Text>
          <Text color={tokens.diffAdd}>+{match[1]}</Text>
          <Text dimColor> </Text>
          <Text color={tokens.diffDel}>-{match[2]}</Text>
          <Text dimColor>)</Text>
        </Text>
      );
    }
  }
  return <Text dimColor={dimmed}>{text}</Text>;
}

export const TranscriptEntry = memo(function TranscriptEntry({
  entry,
  index,
  width,
  streaming = false,
  expanded = false,
  expandedMessage = false,
  expandedNotice = false,
  reasoningToggled = false,
  hideReasoning = false,
  dimmed = false,
  setToolRef,
  mouseSupported = false,
  tokens,
  rowWindow,
}: {
  entry: Entry;
  index: number;
  width: number;
  streaming?: boolean;
  expanded?: boolean;
  expandedMessage?: boolean;
  expandedNotice?: boolean;
  /** This one reasoning block was toggled by hand, flipping the global setting. */
  reasoningToggled?: boolean;
  hideReasoning?: boolean;
  dimmed?: boolean;
  setToolRef: (index: number, element: DOMElement | null) => void;
  mouseSupported?: boolean;
  tokens: UiTokens;
  /** Visible row span for an entry taller than the viewport, so hidden rows are never laid out. */
  rowWindow?: RowWindow;
}) {
  const toolRef = useCallback((element: DOMElement | null) => setToolRef(index, element), [index, setToolRef]);

  if (entry.kind === 'user') {
    const messageExpanded = expandedMessage || !mouseSupported;
    return (
      <Box width="100%" marginBottom={1} flexShrink={0}>
        <Box width={2} flexShrink={0}>
          <Text color={tokens.accent} dimColor={dimmed}>
            {decorate(glyphs.prompt)}
          </Text>
        </Box>
        <Box width={Math.max(1, width - 2)} flexDirection="column">
          {entry.source === 'telegram' ? <Text dimColor>Telegram</Text> : null}
          {entry.text ? <Text dimColor={dimmed}>{messageExpanded ? entry.text : clipped(entry.text, 1_200)}</Text> : null}
          {Array.from({ length: entry.imageCount ?? 0 }, (_, index) => (
            <Text key={index} dimColor>
              [Image attached #{index + 1}]
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  if (entry.kind === 'reasoning') {
    const text = entry.text
      .replace(/\r\n?/g, '\n')
      .replace(/\n[ \t]*\n+/g, '\n')
      .trim();
    if (!text) return null;
    // The header always shows, so the block keeps its place in the transcript and
    // a click can bring the body back. The body follows the global thinking
    // setting unless this one block was toggled by hand, and a hand toggle works
    // in both directions: it opens a hidden block and folds a visible one.
    const bodyVisible = reasoningToggled ? hideReasoning : !hideReasoning;
    const label = entry.durationMs === undefined ? 'Thought' : `Thought for ${formatThoughtDuration(entry.durationMs)}`;
    const marker = mouseSupported ? (bodyVisible ? '▾' : '▸') : '·';
    const header = (
      <Box width="100%" flexShrink={0}>
        <Text dimColor={dimmed} {...(mouseSupported && !dimmed ? { color: tokens.accent } : {})}>
          {`${marker} ${label}`}
        </Text>
      </Box>
    );
    if (!bodyVisible) {
      return (
        <Box width="100%" flexDirection="column" marginBottom={1} flexShrink={0}>
          {header}
        </Box>
      );
    }
    // Reasoning is one plain text run, so a row window can be applied exactly:
    // the lines on screen are the same lines, and the skipped rows become
    // spacers of the same height. The header owns the entry's first row.
    const bodyWindow = rowWindow ? { top: Math.max(0, rowWindow.top - 1), bottom: Math.max(0, rowWindow.bottom - 1) } : null;
    const sliced = bodyWindow ? sliceTextRows(text, width, bodyWindow) : null;
    return (
      <Box width="100%" justifyContent="flex-start" flexDirection="column" marginBottom={1}>
        {rowWindow && rowWindow.top > 0 ? <Box height={1} flexShrink={0} /> : header}
        {sliced && sliced.headRows > 0 ? <Box height={sliced.headRows} flexShrink={0} /> : null}
        <Box width={width}>
          <Text dimColor>{sliced ? sliced.text : text}</Text>
        </Box>
        {sliced && sliced.tailRows > 0 ? <Box height={sliced.tailRows} flexShrink={0} /> : null}
      </Box>
    );
  }

  if (entry.kind === 'assistant') {
    const text = entry.text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
    return (
      <Box width="100%" justifyContent="flex-start" marginBottom={1}>
        <Box width={width}>
          <MarkdownText source={text} width={width} dimmed={dimmed} streaming={streaming} />
        </Box>
      </Box>
    );
  }

  if (entry.kind === 'tool') {
    const showFullDetails = expanded || !mouseSupported;
    const command = displayableCommand(showFullDetails ? toolEntryDetails(entry) : toolEntryCommand(entry));
    const oneLineCommand = command.replace(/\n/g, ' ↵ ');
    const result = displayableCommand(entry.result).trimEnd();
    const activity = toolActivity(entry);
    const commandLimit = Math.max(8, width - (activity.active && !showFullDetails ? toolCommandReserve(entry) : 6));
    return (
      <Box ref={toolRef} flexDirection="column" width="100%" marginBottom={1} flexShrink={0} backgroundColor={tokens.surface}>
        <Box width="100%" flexDirection="row" flexShrink={0}>
          <Text dimColor={dimmed} {...(activity.active ? { color: tokens.accent } : {})}>
            {activity.active ? `${glyphs.spinner[0]} ` : `${glyphs.bullet} `}
          </Text>
          <Text dimColor={dimmed}>{showFullDetails ? command : clipTerminalWidth(oneLineCommand, commandLimit)}</Text>
          {activity.label ? <Text dimColor> {activity.label}</Text> : null}
        </Box>
        {!activity.active && result ? (
          <Box width="100%" flexDirection="row" flexShrink={0}>
            <Text dimColor>{` ${glyphs.result} `}</Text>
            <Box width={Math.max(1, width - 4)} flexDirection="column" flexShrink={1}>
              {renderToolResultText(
                entry.tool,
                showFullDetails ? result : toolOutputPreview(result, Math.max(8, width - 6)),
                dimmed,
                tokens,
              )}
            </Box>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (entry.kind === 'divider' || entry.kind === 'compaction') {
    const label = clipped(entry.kind === 'compaction' ? compactionLabel(entry) : dividerLabel(entry), Math.max(8, width - 4));
    const fill = Math.max(0, width - label.length - 3);
    const left = Math.floor(fill / 2);
    return (
      <Box width="100%" marginBottom={1} flexShrink={0}>
        <Text dimColor={dimmed}>{`${'─'.repeat(left)} ${label} ${'─'.repeat(Math.max(0, fill - left))}`}</Text>
      </Box>
    );
  }

  if (entry.kind === 'notice' && entry.detail) {
    const showDetail = expandedNotice || !mouseSupported;
    const mark = noticeMark(entry.tone, tokens);
    return (
      <Box width="100%" marginBottom={1} flexDirection="column" flexShrink={0}>
        <Text dimColor={dimmed} {...(mark.color ? { color: mark.color } : {})}>
          {`${mark.glyph} `}
          {clipped(entry.text, 1_200)}
        </Text>
        {showDetail ? (
          <Box width={Math.max(1, width - 2)} flexDirection="column" marginLeft={2} flexShrink={0}>
            <Text dimColor>{entry.detail}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  const mark = noticeMark(entry.kind === 'notice' ? entry.tone : undefined, tokens);
  return (
    <Box width="100%" marginBottom={1}>
      <Text dimColor={dimmed} {...(mark.color ? { color: mark.color } : {})}>
        {`${mark.glyph} `}
        {clipped(entry.text, 1_200)}
      </Text>
    </Box>
  );
});

function formatApprovalInput(input: Record<string, unknown>, expanded: boolean, width: number): string {
  const serialized = compactApprovalInput(input, expanded);
  return expanded ? serialized : clipTerminalWidth(serialized, width);
}

function compactApprovalInput(input: Record<string, unknown>, expanded: boolean): string {
  const maxItems = expanded ? 40 : 6;
  const maxString = expanded ? 1_200 : 160;
  const renderValue = (value: unknown, depth: number): string => {
    if (typeof value === 'string') {
      const snippet = value.length > maxString ? value.slice(0, maxString) + `… [${value.length} chars]` : value;
      return JSON.stringify(snippet);
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, maxItems).map((item) => renderValue(item, depth + 1));
      if (value.length > maxItems) items.push(`… ${value.length - maxItems} more`);
      return `[${items.join(', ')}]`;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      const shown = entries.slice(0, maxItems).map(([key, item]) => `${JSON.stringify(key)}: ${renderValue(item, depth + 1)}`);
      if (entries.length > maxItems) shown.push(`… ${entries.length - maxItems} more`);
      const indent = expanded ? '  '.repeat(depth + 1) : '';
      const closeIndent = expanded ? '  '.repeat(depth) : '';
      const separator = expanded ? ',\n' + indent : ', ';
      return entries.length === 0
        ? '{}'
        : `{${expanded ? '\n' + indent : ''}${shown.join(separator)}${expanded ? '\n' + closeIndent : ''}}`;
    }
    return JSON.stringify(value) ?? String(value);
  };
  const lines = Object.entries(input)
    .slice(0, maxItems)
    .map(([key, value]) => `${JSON.stringify(key)}: ${renderValue(value, 0)}`);
  if (Object.keys(input).length > maxItems) lines.push(`… ${Object.keys(input).length - maxItems} more`);
  return lines.length === 0 ? '{}' : `{${expanded ? '\n  ' + lines.join(',\n  ') + '\n' : lines.join(', ')}}`;
}

function hasExpandableApprovalInput(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.length > 160;
  if (Array.isArray(value)) return value.length > 6 || value.some((item) => hasExpandableApprovalInput(item, depth + 1));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length > 6 || entries.some(([, item]) => hasExpandableApprovalInput(item, depth + 1));
  }
  return false;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function clipTerminalWidth(text: string, width: number): string {
  const limit = Math.max(1, width);
  if (terminalTextWidth(text) <= limit) return text;
  let visible = '';
  let used = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = terminalTextWidth(segment);
    if (used + segmentWidth > Math.max(0, limit - 1)) break;
    visible += segment;
    used += segmentWidth;
  }
  return visible + '…';
}

function clipped(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const QUEUED_CARD_PREVIEW_LIMIT = 3;

function formatQueuedPreview(message: { text: string; imageCount: number }): string {
  return [
    message.text.replace(/\s+/g, ' ').trim(),
    ...Array.from({ length: message.imageCount }, (_, index) => `[Image attached #${index + 1}]`),
  ]
    .filter(Boolean)
    .join(' ');
}

function formatContextIndicator(tokens?: number, contextLimit?: number): string {
  if (tokens === undefined) return 'Context —';
  const amount =
    tokens >= 1_000 ? `${(tokens / 1_000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}k` : tokens.toLocaleString('tr-TR');
  return contextLimit && contextLimit > 0 ? `%${Math.round((tokens / contextLimit) * 100)} (${amount})` : `Context ${amount}`;
}

/** A single dim rule with inline metadata: the top screen chrome. */
function hairlineText(left: string, right: string, totalWidth: number): string {
  const leftText = clipped(left, Math.max(4, Math.floor(totalWidth / 2) - 2));
  const rightText = clipped(right, Math.max(4, Math.floor(totalWidth / 3)));
  const middle = Math.max(1, totalWidth - terminalTextWidth(leftText) - terminalTextWidth(rightText) - 8);
  return `── ${leftText} ${'─'.repeat(middle)} ${rightText} ──`;
}

type MarkdownRenderCache = {
  lastSource: string;
  stableLength: number;
  stableTokens: Token[];
  stableNodes: ReactNode[];
  width: number;
  dimmed: boolean;
};

function MarkdownText({
  source,
  width,
  dimmed = false,
  streaming = false,
}: {
  source: string;
  width: number;
  dimmed?: boolean;
  streaming?: boolean;
}) {
  const cache = useRef<MarkdownRenderCache | null>(null);
  const rendered = useMemo(() => {
    if (!streaming) {
      const tokens = markdownParser.lexer(source);
      const nodes = renderMarkdownBlocks(tokens, width, dimmed, 'markdown');
      cache.current = {
        lastSource: source,
        stableLength: source.length,
        stableTokens: tokens,
        stableNodes: nodes,
        width,
        dimmed,
      };
      return { stableNodes: nodes, tailNodes: [] as ReactNode[] };
    }

    let current = cache.current;
    if (!current || current.width !== width || current.dimmed !== dimmed || !source.startsWith(current.lastSource)) {
      current = { lastSource: '', stableLength: 0, stableTokens: [], stableNodes: [], width, dimmed };
    }
    const addedText = source.slice(current.lastSource.length);
    const previousHadLineBreak = current.lastSource.endsWith('\n');
    if (addedText.includes('\n\n') || (previousHadLineBreak && addedText.startsWith('\n'))) {
      const uncommitted = source.slice(current.stableLength);
      const boundary = findStableMarkdownBoundary(uncommitted);
      if (boundary > 0) {
        const completedTokens = markdownParser
          .lexer(uncommitted.slice(0, boundary))
          .filter((token) => token.type !== 'space' && token.type !== 'def');
        const previousCount = current.stableTokens.length;
        const mergedTokens = mergeMarkdownTokenSegments(current.stableTokens, completedTokens);
        if (mergedTokens.length === previousCount + completedTokens.length) {
          const appendedNodes = renderMarkdownBlocks(completedTokens, width, dimmed, 'markdown-stable', previousCount);
          current.stableNodes = [...current.stableNodes, ...appendedNodes];
        } else {
          // A merge can chain across several completed tokens, so re-render everything from the merged tail on.
          const mergedIndex = Math.max(0, previousCount - 1);
          const mergedNodes = renderMarkdownBlocks(mergedTokens.slice(mergedIndex), width, dimmed, 'markdown-stable', mergedIndex);
          current.stableNodes = [...current.stableNodes.slice(0, mergedIndex), ...mergedNodes];
        }
        current.stableTokens = mergedTokens;
        current.stableLength += boundary;
      }
    }
    const tailTokens = markdownParser.lexer(source.slice(current.stableLength));
    const tailNodes = renderMarkdownBlocks(tailTokens, width, dimmed, 'markdown-tail');
    current.lastSource = source;
    cache.current = current;
    return { stableNodes: current.stableNodes, tailNodes };
  }, [dimmed, source, streaming, width]);

  return (
    <Box width={width} flexDirection="column" flexShrink={0}>
      {rendered.stableNodes}
      {rendered.tailNodes}
    </Box>
  );
}

function findStableMarkdownBoundary(source: string): number {
  let offset = 0;
  let stableBoundary = 0;
  let fenceCharacter: '`' | '~' | null = null;
  let fenceLength = 0;
  const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
  for (const line of lines) {
    if (!line) continue;
    const content = line.replace(/\r?\n$/, '');
    const fence = content.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1]!;
      const character = marker[0] as '`' | '~';
      if (fenceCharacter === null) {
        fenceCharacter = character;
        fenceLength = marker.length;
      } else if (character === fenceCharacter && marker.length >= fenceLength) {
        fenceCharacter = null;
        fenceLength = 0;
      }
    }
    offset += line.length;
    if (fenceCharacter === null && line.endsWith('\n') && content.trim() === '') stableBoundary = offset;
  }
  return stableBoundary;
}

function renderMarkdownBlocks(
  tokens: Token[],
  width: number,
  dimmed: boolean,
  keyPrefix: string,
  startIndex = 0,
  spaced = true,
): ReactNode[] {
  const gap = spaced ? 1 : 0;
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${startIndex + index}`;
    switch (token.type) {
      case 'space':
      case 'def':
        return null;
      case 'heading': {
        const heading = token as Tokens.Heading;
        return (
          <Box key={key} width="100%" marginBottom={gap} flexShrink={0}>
            <Text bold color={heading.depth <= 2 ? 'cyan' : 'white'} dimColor={dimmed}>
              {renderInlineMarkdown(heading.tokens, dimmed, key)}
            </Text>
          </Box>
        );
      }
      case 'paragraph':
        return (
          <Box key={key} width="100%" marginBottom={gap} flexShrink={0}>
            <Text wrap="wrap" dimColor={dimmed}>
              {renderInlineMarkdown(childMarkdownTokens(token), dimmed, key)}
            </Text>
          </Box>
        );
      case 'text': {
        const textToken = token as Tokens.Text;
        return (
          <Box key={key} width="100%" marginBottom={gap} flexShrink={0}>
            <Text wrap="wrap" dimColor={dimmed}>
              {textToken.tokens ? renderInlineMarkdown(textToken.tokens, dimmed, key) : textToken.text}
            </Text>
          </Box>
        );
      }
      case 'code': {
        const codeToken = token as Tokens.Code;
        let code = codeToken.text;
        if (codeToken.lang?.trim().toLowerCase() === 'mermaid') {
          try {
            code = renderMermaidASCII(codeToken.text, { colorMode: 'none', paddingX: 2, paddingY: 1 });
          } catch {
            code = codeToken.text;
          }
        }
        // No left bar: any glyph before the text lands in a terminal selection,
        // so code copied with the terminal (not the in-app selection) would come
        // out prefixed. Colour and the blank line above and below carry the block.
        return (
          <Box key={key} width={width} flexDirection="column" marginBottom={gap} flexShrink={0}>
            {code.split('\n').map((line, lineIndex) => (
              <Text
                key={`${key}-line-${lineIndex}`}
                color={codeToken.lang?.toLowerCase() === 'mermaid' ? 'cyan' : 'yellow'}
                wrap="wrap"
                dimColor={dimmed}
              >
                {line || ' '}
              </Text>
            ))}
          </Box>
        );
      }
      case 'blockquote': {
        const quote = token as Tokens.Blockquote;
        return <MarkdownBlockquote key={key} tokens={quote.tokens} width={width} dimmed={dimmed} keyPrefix={key} spaced={spaced} />;
      }
      case 'list':
        return renderMarkdownList(token as Tokens.List, width, dimmed, key, spaced);
      case 'table':
        return renderMarkdownTable(token as Tokens.Table, width, dimmed, key, spaced);
      case 'hr':
        return (
          <Box key={key} width="100%" marginBottom={gap}>
            <Text dimColor={dimmed}>{'─'.repeat(Math.max(1, width))}</Text>
          </Box>
        );
      case 'html':
        return (token as Tokens.HTML).text.trim() ? (
          <Box key={key} width="100%" marginBottom={gap}>
            <Text wrap="wrap" dimColor={dimmed}>
              {(token as Tokens.HTML).text}
            </Text>
          </Box>
        ) : null;
      default:
        return (
          <Box key={key} width="100%" marginBottom={gap}>
            <Text wrap="wrap" dimColor={dimmed}>
              {renderInlineMarkdown([token], dimmed, key)}
            </Text>
          </Box>
        );
    }
  });
}

/**
 * A blockquote draws its bar on every rendered line, including wrapped and
 * nested content. Ink's own border cannot be marked as chrome, so the bar is
 * text: the content height is measured and the bar is emitted as that many
 * decorated lines, which keeps it out of a copy.
 */
function MarkdownBlockquote({
  tokens,
  width,
  dimmed,
  keyPrefix,
  spaced = true,
}: {
  tokens: Token[];
  width: number;
  dimmed: boolean;
  keyPrefix: string;
  spaced?: boolean;
}) {
  const contentRef = useRef<DOMElement>(null);
  const { height } = useBoxMetrics(contentRef);
  const bodyWidth = Math.max(1, width - 2);
  // One decorated marker per line: the copy path resets its decoration state at
  // each newline, so a single marker spanning the whole column would leak.
  const bar = height > 0 ? Array.from({ length: height }, () => decorate('│ ')).join('\n') : '';
  return (
    <Box width="100%" flexDirection="row" marginBottom={spaced ? 1 : 0} flexShrink={0}>
      <Box width={2} flexShrink={0}>
        <Text dimColor={dimmed}>{bar}</Text>
      </Box>
      <Box ref={contentRef} width={bodyWidth} flexDirection="column" flexShrink={1}>
        {renderMarkdownBlocks(tokens, bodyWidth, dimmed, keyPrefix, 0, false)}
      </Box>
    </Box>
  );
}

/** Exported for tests: this is the terminal's inline renderer, links included. */
export function renderInlineMarkdown(tokens: Token[], dimmed: boolean, keyPrefix: string): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-inline-${index}`;
    switch (token.type) {
      case 'strong':
        return (
          <Text key={key} bold dimColor={dimmed}>
            {renderInlineMarkdown(childMarkdownTokens(token), dimmed, key)}
          </Text>
        );
      case 'em':
        return (
          <Text key={key} italic dimColor={dimmed}>
            {renderInlineMarkdown(childMarkdownTokens(token), dimmed, key)}
          </Text>
        );
      case 'del':
        return (
          <Text key={key} strikethrough dimColor={dimmed}>
            {renderInlineMarkdown(childMarkdownTokens(token), dimmed, key)}
          </Text>
        );
      case 'codespan':
        return (
          <Text key={key} dimColor>
            {token.text}
          </Text>
        );
      case 'link': {
        const inner = renderInlineMarkdown(childMarkdownTokens(token), dimmed, key);
        // A workspace citation keeps its path visible: the terminal cannot open
        // the file, so the path is the information the reader still needs.
        const target = parseHref(token.href);
        if (target?.kind === 'file') {
          return (
            <Text key={key}>
              <Text underline dimColor={dimmed}>
                {inner}
              </Text>
              <Text dimColor> {displayFilePath(target)}</Text>
            </Text>
          );
        }
        return (
          <Text key={key} underline dimColor={dimmed}>
            {inner}
          </Text>
        );
      }
      case 'image':
        return (
          <Text key={key} dimColor={dimmed}>
            [Image: {token.text || token.href}]
          </Text>
        );
      case 'br':
        return <Fragment key={key}>{'\n'}</Fragment>;
      case 'escape':
        return <Fragment key={key}>{token.text}</Fragment>;
      case 'text':
        return <Fragment key={key}>{token.tokens ? renderInlineMarkdown(token.tokens, dimmed, key) : token.text}</Fragment>;
      case 'html':
        return <Fragment key={key}>{token.text}</Fragment>;
      default: {
        const nested =
          'tokens' in token && Array.isArray(token.tokens)
            ? renderInlineMarkdown(token.tokens, dimmed, key)
            : 'text' in token && typeof token.text === 'string'
              ? token.text
              : token.raw;
        return <Fragment key={key}>{nested}</Fragment>;
      }
    }
  });
}

function renderMarkdownList(list: Tokens.List, width: number, dimmed: boolean, key: string, spaced = true): ReactNode {
  const startingNumber = typeof list.start === 'number' ? list.start : 1;
  return (
    <Box key={key} width="100%" flexDirection="column" marginBottom={spaced ? 1 : 0} flexShrink={0}>
      {list.items.map((item, index) => {
        const marker = item.task ? (item.checked ? '☑' : '☐') : list.ordered ? `${startingNumber + index}.` : '•';
        const content = item.tokens.filter((part) => part.type !== 'space');
        const first = content[0];
        const firstInline =
          first?.type === 'paragraph' || first?.type === 'text'
            ? 'tokens' in first && first.tokens
              ? first.tokens
              : [{ type: 'text', raw: first.raw, text: first.text } as Token]
            : null;
        const nested = firstInline ? content.slice(1) : content;
        return (
          <Box key={`${key}-item-${index}`} width="100%" flexDirection="row" flexShrink={0} marginBottom={list.loose ? 1 : 0}>
            <Text {...(item.task ? { color: 'cyan' as const } : {})} dimColor={dimmed}>
              {marker}{' '}
            </Text>
            <Box width={Math.max(1, width - marker.length - 1)} flexDirection="column" flexShrink={1}>
              {firstInline ? (
                <Text wrap="wrap" dimColor={dimmed}>
                  {renderInlineMarkdown(firstInline, dimmed, `${key}-item-${index}`)}
                </Text>
              ) : null}
              {nested.length > 0
                ? renderMarkdownBlocks(nested, Math.max(1, width - marker.length - 1), dimmed, `${key}-item-${index}-nested`, 0, false)
                : null}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function renderMarkdownTable(table: Tokens.Table, width: number, dimmed: boolean, key: string, spaced = true): ReactNode {
  const rows = [table.header, ...table.rows];
  const columns = table.header.length;
  if (columns === 0) return null;
  const separatorBudget = Math.max(0, columns - 1) * 3;
  const contentBudget = Math.max(columns, width - separatorBudget);
  const minimumWidth = Math.max(1, Math.min(6, Math.floor(contentBudget / columns)));
  const columnWidths = table.header.map((_, column) =>
    Math.max(minimumWidth, ...rows.map((row) => terminalTextWidth(markdownPlainText(row[column]?.tokens ?? [])))),
  );
  let totalWidth = columnWidths.reduce((total, value) => total + value, 0);
  while (totalWidth > contentBudget) {
    const widest = columnWidths.reduce((best, value, index) => (value > columnWidths[best]! ? index : best), 0);
    if (columnWidths[widest]! <= minimumWidth) break;
    columnWidths[widest]!--;
    totalWidth--;
  }
  const divider = columnWidths.map((columnWidth) => '─'.repeat(columnWidth)).join('─┼─');
  return (
    <Box key={key} width="100%" flexDirection="column" marginBottom={spaced ? 1 : 0} flexShrink={0}>
      {rows.map((row, rowIndex) => (
        <Fragment key={`${key}-row-${rowIndex}`}>
          <Box width="100%" flexDirection="row" flexShrink={0}>
            {row.map((cell, columnIndex) => (
              <Fragment key={`${key}-row-${rowIndex}-cell-${columnIndex}`}>
                <Box width={columnWidths[columnIndex]} flexShrink={0}>
                  <Text bold={rowIndex === 0} wrap="wrap" dimColor={dimmed}>
                    {renderInlineMarkdown(cell.tokens, dimmed, `${key}-cell-${rowIndex}-${columnIndex}`)}
                  </Text>
                </Box>
                {columnIndex < row.length - 1 ? <Text dimColor={dimmed}> │ </Text> : null}
              </Fragment>
            ))}
          </Box>
          {rowIndex === 0 ? <Text dimColor={dimmed}>{divider}</Text> : null}
        </Fragment>
      ))}
    </Box>
  );
}

function markdownPlainText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'strong':
        case 'em':
        case 'del':
          return markdownPlainText(childMarkdownTokens(token));
        case 'link': {
          const target = parseHref(token.href);
          return target?.kind === 'file' ? `${token.text} ${displayFilePath(target)}` : token.text;
        }
        case 'image':
          return token.text;
        case 'br':
          return '\n';
        case 'escape':
        case 'codespan':
        case 'text':
        case 'html':
          return token.text;
        default:
          return 'text' in token && typeof token.text === 'string' ? token.text : token.raw;
      }
    })
    .join('');
}

function childMarkdownTokens(token: Token): Token[] {
  return 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : [];
}

/** Printable ASCII is one column per character, so the common case skips grapheme segmentation. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function terminalTextWidth(text: string): number {
  const plain = text.includes('\u001b') ? text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '') : text;
  return PRINTABLE_ASCII.test(plain) ? plain.length : stringWidth(plain);
}
