import { whatsappUrl } from "../lib/share";

/** Lien « Envoyer sur WhatsApp » (application sur téléphone, WhatsApp Web sur ordinateur). */
export function WhatsAppButton({ text, className = "" }: { text: string; className?: string }) {
  return (
    <a href={whatsappUrl(text)} target="_blank" rel="noopener noreferrer" title="Envoyer sur WhatsApp"
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[#25D366]/60 px-3 py-1.5 text-sm font-semibold text-[#25D366] hover:bg-[#25D366]/10 ${className}`}>
      <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
        <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.6-.3Z" />
      </svg>
      WhatsApp
    </a>
  );
}
