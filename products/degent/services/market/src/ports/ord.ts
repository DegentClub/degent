/** Where an inscription is right now (ord recursive endpoints). */
export interface InscriptionLocation {
  id: string;
  number: number | null;
  /** Current holder address (null for non-standard scripts). */
  address: string | null;
  /** `txid:vout` of the UTXO carrying it. */
  outpoint: string;
  /** Offset of the inscribed sat inside that UTXO. */
  offset: number;
  /** Value of that UTXO (postage). */
  value: number;
  contentType: string;
}

export interface OrdIndexer {
  /** Null when the indexer does not know the inscription. */
  getInscription(id: string): Promise<InscriptionLocation | null>;
  /** Ids of the inscriptions sitting on an outpoint (empty when none / unknown). */
  getOutpointInscriptions(outpoint: string): Promise<string[]>;
}
