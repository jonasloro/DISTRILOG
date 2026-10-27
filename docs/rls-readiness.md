# DISTRILOG — checklist para habilitar RLS (não ativar diretamente em produção)

## O que foi alterado
- Autenticação das rotas `/api/*` por cookie assinado, HttpOnly, Secure, SameSite=Strict, com validade de oito horas.
- Login exige `AUTH_SESSION_SECRET` com pelo menos 32 caracteres aleatórios no Render.
- O navegador não pode se autenticar apenas com dados armazenados em localStorage.
- Alterações que informam `user_id` na query ou nos campos JSON `user_id`, `created_by`, `updated_by` devem corresponder à sessão.
- Cadastro de usuários exige sessão administrativa e confirmação da senha do administrador.
- A senha temporária precisa ser trocada no primeiro acesso.

## Pré-requisitos antes do deploy
1. Gerar um segredo aleatório de pelo menos 32 caracteres e configurar `AUTH_SESSION_SECRET` no Render (não enviar ao GitHub).
2. Confirmar `SUPABASE_DATABASE_URL` e HTTPS do domínio público.
3. Fazer backup do banco.
4. Testar login, primeiro acesso, logout, sessão expirada e os fluxos de todos os setores com contas distintas.
5. Revisar endpoints que aceitam IDs de outros operadores (`inspector_id`, `worker_id` etc.) e adicionar checagem de autorização no servidor por ação. A autenticação por sessão não substitui a autorização por objeto/rota.
6. Implementar revogação de sessões no servidor para logout e troca de senha. O cookie assinado atual é stateless: logout apaga o cookie do navegador, mas não invalida uma cópia eventualmente roubada antes do vencimento.
7. Configurar rate limiting para tentativas de login e troca de senha.

## Diagnóstico de privilégios do PostgreSQL
Executar no SQL Editor do Supabase, sem modificar permissões:

```sql
SELECT current_user, session_user,
       rolbypassrls, rolsuper
FROM pg_roles WHERE rolname = current_user;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS force_rls,
       pg_get_userbyid(c.relowner) AS table_owner
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('distrilog','public') AND c.relkind IN ('r','p')
ORDER BY 1,2;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname IN ('distrilog','public')
ORDER BY 1,2,3;
```

**Atenção:** o SQL Editor pode usar um papel diferente do usuário da connection string do Render. Verificar também o usuário da conexão da aplicação. Donos de tabelas, superusers e papéis com BYPASSRLS podem ignorar RLS. O backend usa conexões diretas ao PostgreSQL, não tokens Supabase Auth por operador; políticas baseadas em `auth.uid()` não vão identificar automaticamente os operadores do DISTRILOG.

## Estratégia para adoção
1. Criar papel PostgreSQL de aplicação sem BYPASSRLS e sem propriedade das tabelas.
2. Definir a identidade autenticada em cada transação com mecanismo protegido, sem confiar em valores do cliente.
3. Projetar políticas por tabela e operação, com `USING` e `WITH CHECK`, considerando fluxos entre setores e ações administrativas.
4. Testar com o papel real do Render, em staging e com dados de teste, incluindo consultas, inserções, atualizações e deleções.
5. Habilitar RLS gradualmente e só então migrar a connection string do Render, com plano de rollback.

**Não execute `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` indiscriminadamente agora.** O RLS ainda não está configurado nem homologado. Este documento é um plano de implantação, não uma migração pronta.
