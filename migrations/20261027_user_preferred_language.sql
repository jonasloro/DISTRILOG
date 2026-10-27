-- Per-user display language. Operational statuses, IDs, references and WMS addresses remain unchanged.
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS idioma_preferido TEXT NOT NULL DEFAULT 'pt-BR';
ALTER TABLE public.usuarios DROP CONSTRAINT IF EXISTS usuarios_idioma_preferido_check;
ALTER TABLE public.usuarios ADD CONSTRAINT usuarios_idioma_preferido_check CHECK (idioma_preferido IN ('pt-BR','es'));
