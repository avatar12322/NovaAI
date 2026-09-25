export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Zasób') => new HttpError(404, 'not_found', `${what} nie istnieje`);
export const forbidden = (msg = 'Brak uprawnień') => new HttpError(403, 'forbidden', msg);
export const badRequest = (msg: string, details?: unknown) =>
  new HttpError(400, 'bad_request', msg, details);
export const conflict = (code: string, msg: string) => new HttpError(409, code, msg);
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Wymagane zalogowanie');
