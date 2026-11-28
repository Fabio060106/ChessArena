/** Liens de partage par messagerie (aucun script tiers : de simples adresses). */
export const whatsappUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;

export function shareTargets(text: string, url: string, mobile: boolean): Array<{ id: string; label: string; href: string }> {
  const u = encodeURIComponent(url);
  const bare = encodeURIComponent(text.replace(url, "").trim());
  const full = encodeURIComponent(text.includes(url) ? text : `${text} ${url}`);
  return [
    { id: "telegram", label: "Telegram", href: `https://t.me/share/url?url=${u}&text=${bare}` },
    ...(mobile ? [{ id: "messenger", label: "Messenger", href: `fb-messenger://share/?link=${u}` }] : []),
    { id: "snapchat", label: "Snapchat", href: `https://www.snapchat.com/scan?attachmentUrl=${u}` },
    { id: "sms", label: "SMS", href: `sms:?&body=${full}` },
    { id: "email", label: "E-mail", href: `mailto:?subject=${encodeURIComponent("Échecs sur ChessAurum")}&body=${full}` },
    { id: "x", label: "X (Twitter)", href: `https://twitter.com/intent/tweet?text=${bare}&url=${u}` },
  ];
}
