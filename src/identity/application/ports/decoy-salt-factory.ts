/** Port: deterministic fake KDF salt for pre-login of unknown e-mails. */
export abstract class DecoySaltFactory {
  abstract saltFor(normalizedEmail: string): Promise<string>;
}
