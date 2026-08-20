# Testes locais do SGO v12

Execute a partir de Linux, macOS ou WSL com Python 3 e Node.js instalados:

```bash
./tools/validate_release.sh
```

A validação monta a prévia do HTML, verifica a sintaxe de todos os arquivos Apps Script e do JavaScript do navegador e executa:

- testes de contrato entre frontend e servidor;
- testes de integração com simulação em memória das APIs do Apps Script;
- testes comportamentais do frontend;
- suíte de compatibilidade do servidor.

Esses testes reduzem o risco de erros de código e integração. Eles não reproduzem integralmente latência, cotas, permissões, gatilhos e concorrência reais da infraestrutura Google; por isso a homologação em uma cópia da planilha continua obrigatória.
