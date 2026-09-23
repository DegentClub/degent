export const peer = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });
export const json = async (res: Response) => (await res.json()) as { error: { code: string; message: string; requestId: string | null } };
