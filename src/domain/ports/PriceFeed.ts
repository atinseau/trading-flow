export type PriceTick = {
  asset: string;
  price: number;
  timestamp: Date;
};

export interface PriceFeed {
  readonly source: string;
  subscribe(args: { watchId: string; assets: string[] }): AsyncIterable<PriceTick>;
}
