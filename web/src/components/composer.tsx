import { forwardRef, useLayoutEffect, useRef, useState } from 'react';
import type { DraftImage, ModelChoice, RuntimeInfo } from '../types.js';
import { readImage } from '../image-input.js';
import { useDictation } from '../use-dictation.js';
import { Brand, Button, Icon, IconButton } from './ui.js';
import { Popover } from './popover.js';
interface ComposerProps {
  workspace: string;
  runtime?: RuntimeInfo;
  models: ModelChoice[];
  draft: string;
  images: DraftImage[];
  onImages: (images: DraftImage[]) => void;
  busy: boolean;
  disabled: boolean;
  changing: boolean;
  empty: boolean;
  onDraft: (text: string) => void;
  onSend: (text: string, images?: DraftImage[], reasoningVariantId?: string) => Promise<void>;
  onStop: () => void;
  onModel: (model: ModelChoice) => void;
  onDetails: () => void;
}
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(props, forwardedRef) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [readingImages, setReadingImages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [reasoning, setReasoning] = useState<{ model: string; id: string } | null>(null);
  const modelId = props.runtime?.modelId || '';
  const variants = props.runtime?.reasoningVariants || [];
  const selectedReasoning = reasoning?.model === modelId ? reasoning.id : props.runtime?.reasoningDefault;
  const reasoningIndex = Math.max(
    0,
    variants.findIndex((variant) => variant.id === selectedReasoning),
  );
  const reasoningLabel = variants[reasoningIndex]?.label;
  const dictation = useDictation((text) => props.onDraft([props.draft, text].filter(Boolean).join(' ')), setError);
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(200, Math.max(26, input.current.scrollHeight))}px`;
  }, [props.draft]);
  const submit = async () => {
    const text = props.draft.trim();
    if ((!text && !props.images.length) || sending.current || props.disabled || readingImages) return;
    sending.current = true;
    setPending(true);
    setError(null);
    if (dictation.listening) dictation.toggle();
    try {
      await props.onSend(text, props.images, variants[reasoningIndex]?.id);
      props.onDraft('');
      props.onImages([]);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      sending.current = false;
      setPending(false);
      input.current?.focus();
    }
  };
  const addImages = async (files: FileList | null) => {
    if (!files?.length) return;
    if (props.images.length + files.length > 4) {
      setError('En fazla dört görsel ekleyebilirsiniz.');
      return;
    }
    setReadingImages(true);
    setError(null);
    try {
      props.onImages([...props.images, ...(await Promise.all(Array.from(files).map(readImage)))]);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setReadingImages(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const modelName = modelId.split('/').pop() || props.runtime?.modelName || 'Model';
  return (
    <div className={`composer-dock${props.empty ? ' composer-empty' : ''}`}>
      {props.empty ? (
        <div className="welcome">
          <Brand large />
          <h1>
            <span>{props.workspace}</span> projesinde ne oluşturalım?
          </h1>
        </div>
      ) : null}
      {error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : null}
      <form
        className="composer"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length) {
            event.preventDefault();
            if (!props.disabled && !pending && !readingImages) void addImages(event.dataTransfer.files);
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {props.images.length ? (
          <div className="image-previews">
            {props.images.map((image) => (
              <div className="image-preview" key={image.id}>
                <img src={image.dataUrl} alt={image.name} />
                <IconButton
                  icon="close"
                  label={`${image.name} görselini kaldır`}
                  disabled={pending}
                  onClick={() => props.onImages(props.images.filter((item) => item.id !== image.id))}
                />
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={(node) => {
            input.current = node;
            if (typeof forwardedRef === 'function') forwardedRef(node);
            else if (forwardedRef) forwardedRef.current = node;
          }}
          aria-label="Message Ranite"
          placeholder="Bir şey sor veya ne yapmak istediğini anlat…"
          value={props.draft}
          disabled={props.disabled || pending}
          rows={1}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              if (!props.disabled && !pending && !readingImages) void addImages(event.clipboardData.files);
            }
          }}
          onChange={(event) => props.onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-toolbar">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            hidden
            aria-label="Görsel ekle"
            onChange={(event) => void addImages(event.target.files)}
          />
          <Popover
            className="attachment-popover"
            label="Ekle"
            disabled={props.disabled || pending || readingImages}
            trigger={<Icon name="plus" />}
          >
            {(close) => (
              <>
                <Button
                  className="attachment-option"
                  icon="image"
                  onClick={() => {
                    fileInput.current?.click();
                    close();
                  }}
                >
                  Görsel ekle
                </Button>
                <Button
                  className="attachment-option"
                  icon="folder"
                  onClick={() => {
                    props.onDetails();
                    close();
                  }}
                >
                  Çalışma alanı
                </Button>
              </>
            )}
          </Popover>
          <Button className="permission-button" aria-label="View permissions" icon="shield" onClick={props.onDetails}>
            {props.runtime?.approvalMode === 'full-access'
              ? 'Tam erişim'
              : props.runtime?.approvalMode === 'auto-review'
                ? 'Otomatik inceleme'
                : 'Onay iste'}
          </Button>
          <span className="spacer" />
          {readingImages ? (
            <span className="upload-status" role="status">
              Görsel hazırlanıyor…
            </span>
          ) : null}
          <Popover
            className="model-popover"
            label="Choose model"
            disabled={props.disabled || props.busy || props.changing || pending}
            trigger={
              <>
                <span className="model-label">
                  {modelName} {reasoningLabel ? <span className="reasoning-label">{reasoningLabel}</span> : null}
                </span>
                <Icon name="chevron" />
              </>
            }
          >
            {(close) =>
              showModels ? (
                <>
                  <div className="popover-heading">
                    <Button onClick={() => setShowModels(false)}>Geri</Button>Modeller
                  </div>
                  <div className="model-list">
                    {props.models.map((model) => {
                      const selected = model.providerId === props.runtime?.providerId && model.modelId === modelId;
                      return (
                        <button
                          type="button"
                          className="model-option"
                          key={`${model.providerId}/${model.modelId}`}
                          aria-pressed={selected}
                          onClick={() => {
                            if (!selected) props.onModel(model);
                            setShowModels(false);
                            close();
                          }}
                        >
                          <span>
                            <strong>{model.name}</strong>
                            <small>{model.providerId}</small>
                          </span>
                          {selected ? <Icon name="check" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="reasoning-controls">
                  <div className="reasoning-heading">
                    <Icon name="spark" />
                    <strong>{reasoningLabel || 'Varsayılan'}</strong>
                    <IconButton icon="reset" label="Varsayılan düzeye dön" onClick={() => setReasoning(null)} />
                  </div>
                  <Button className="current-model-choice" onClick={() => setShowModels(true)}>
                    {modelName}
                    <Icon name="chevron" />
                  </Button>
                  {variants.length > 1 ? (
                    <input
                      className="reasoning-range"
                      style={{
                        background: `linear-gradient(to right, #4185f7 ${(reasoningIndex / (variants.length - 1)) * 100}%, #e9e9ec ${(reasoningIndex / (variants.length - 1)) * 100}%)`,
                      }}
                      aria-valuetext={reasoningLabel}
                      aria-label="Akıl yürütme düzeyi"
                      type="range"
                      min={0}
                      max={variants.length - 1}
                      step={1}
                      value={reasoningIndex}
                      onChange={(event) => setReasoning({ model: modelId, id: variants[Number(event.target.value)].id })}
                    />
                  ) : (
                    <p className="reasoning-note">
                      {variants.length ? 'Bu modelin sabit düşünme düzeyi kullanılıyor.' : 'Bu model ek düşünme ayarı sunmuyor.'}
                    </p>
                  )}
                </div>
              )
            }
          </Popover>
          <IconButton
            icon="mic"
            label={dictation.listening ? 'Dikteyi durdur' : 'Sesle yaz'}
            className={dictation.listening ? 'mic-button listening' : 'mic-button'}
            disabled={props.disabled || pending || !dictation.supported}
            title={dictation.supported ? 'Sesle yaz' : 'Bu tarayıcı sesle yazmayı desteklemiyor'}
            onClick={dictation.toggle}
          />
          {props.busy ? <IconButton icon="stop" label="Stop response" className="stop-button" onClick={props.onStop} /> : null}
          <IconButton
            type="submit"
            icon="arrow"
            label={props.busy ? 'Queue message' : 'Send message'}
            className="send-button"
            disabled={props.disabled || pending || readingImages || (!props.draft.trim() && !props.images.length)}
          />
        </div>
      </form>
    </div>
  );
});
