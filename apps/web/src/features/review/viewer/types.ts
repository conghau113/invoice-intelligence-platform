/** What the viewer needs to point at a place in the document: the AI's `evidence` (page + excerpt). */
export interface ViewerEvidence {
  page: number;
  text: string;
}
