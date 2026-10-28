# DISTRILOG Mobile — APK Android de homologação

Aplicativo Android nativo enxuto para validar login e fluxos reais do DISTRILOG hospedado no Render.
Usa WebView autenticada para as telas operacionais (não duplica regras do WMS); oferece leitor de QR nativo,
com cópia do código para colar no formulário. Não envia o QR automaticamente nem movimenta mercadoria.
Informe a URL HTTPS do Render no primeiro acesso. HTTPS obrigatório; cookies do backend são usados na WebView.
Atenção: utiliza ambiente real quando apontado para o endereço de produção. Teste com cards de homologação.
É uma **versão Android operacional enxuta**, não a compilação integral do protótipo Expo V06
(os modos simulados não foram incluídos). APK de debug é assinado apenas para testes, não para Google Play.
Branch de compilação isolada, sem alterações no backend e na branch main.
