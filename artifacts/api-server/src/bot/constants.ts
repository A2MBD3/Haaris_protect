export const HARDCODED_SUPER_ADMINS: number[] = [8074495633, 5883825451];

export const LOCK_TYPES = [
  "gif",
  "sticker",
  "media",
  "link",
  "photo",
  "video",
  "voice",
  "document",
  "audio",
  "forward",
  "poll",
  "game",
  "contact",
  "location",
] as const;

export type LockType = (typeof LOCK_TYPES)[number];
