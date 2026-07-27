export interface Item {
  id: string;
  name: string;
  createdAt: string;
}

export interface CreateItemRequest {
  name: string;
}

export interface ListItemsResponse {
  items: Item[];
}
