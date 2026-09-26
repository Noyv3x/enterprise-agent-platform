import type { ChangeEvent, ReactNode, RefObject } from "react";
import { useI18n } from "../../i18n";
import { ComposerFrame } from "../ui/fieldwork";
import { AttachButton } from "./AttachButton";
import { ComposerTextarea, type ComposerTextareaProps } from "./ComposerTextarea";
import { MentionMenu } from "./MentionMenu";
import { SendButton } from "./SendButton";
import { SlashCommandMenu } from "./SlashCommandMenu";

export function ComposerField({ disabled, busy, fileInputRef, onFileChange, textarea, slashCommand, attachments, hint, recovery, usage }: {
  disabled: boolean;
  busy: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  textarea: ComposerTextareaProps;
  slashCommand: { visible: boolean; onChoose: () => void; menuId: string; optionId: string };
  attachments?: ReactNode;
  hint?: ReactNode;
  recovery?: ReactNode;
  /** Quiet status shown before the send button (context usage). */
  usage?: ReactNode;
}) {
  const { t } = useI18n();
  return <ComposerFrame
    label={t("chat.composer.label")}
    disabled={disabled}
    input={<ComposerTextarea {...textarea} />}
    suggestions={<><MentionMenu mention={textarea.mention} /><SlashCommandMenu {...slashCommand} /></>}
    startActions={<>
      <input hidden type="file" multiple disabled={disabled} ref={fileInputRef} onChange={onFileChange} tabIndex={-1} />
      <AttachButton disabled={disabled} onClick={() => fileInputRef.current?.click()} />
    </>}
    submitAction={<>{usage}<SendButton disabled={disabled || (!textarea.value.trim() && !attachments)} loading={busy} /></>}
    attachments={attachments}
    recovery={recovery}
    hint={hint}
  />;
}
