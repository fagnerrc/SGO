import { login } from "../lib/auth";

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "E-mail ou PIN incorretos.",
  ACCOUNT_LOCKED: "Conta bloqueada por excesso de tentativas. Tente novamente mais tarde.",
  SERVER_ERROR: "Não foi possível conectar. Tente novamente.",
};

export function renderLogin(root: HTMLElement, onSuccess: () => void): void {
  root.innerHTML = `
    <div class="login-screen">
      <form id="login-form" class="login-card">
        <h1>SGO</h1>
        <label for="email">E-mail</label>
        <input id="email" name="email" type="email" autocomplete="username" required />
        <label for="pin">PIN de acesso</label>
        <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required />
        <button type="submit">Entrar</button>
        <p id="login-error" class="error" hidden></p>
      </form>
    </div>
  `;

  const form = root.querySelector<HTMLFormElement>("#login-form")!;
  const errorEl = root.querySelector<HTMLParagraphElement>("#login-error")!;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    const email = (form.elements.namedItem("email") as HTMLInputElement).value.trim();
    const pin = (form.elements.namedItem("pin") as HTMLInputElement).value.trim();

    const submitButton = form.querySelector("button")!;
    submitButton.disabled = true;
    try {
      const result = await login(email, pin);
      if ("errorCode" in result) {
        errorEl.textContent = ERROR_MESSAGES[result.errorCode] ?? "Não foi possível entrar.";
        errorEl.hidden = false;
        return;
      }
      onSuccess();
    } finally {
      submitButton.disabled = false;
    }
  });
}
