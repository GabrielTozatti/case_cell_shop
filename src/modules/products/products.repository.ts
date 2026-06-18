export interface Product {
    id: string;
    name: string;
    description: string;
    price: number;
    stock: number;
    category: string;
    sku: string;
}

const PRODUCTS: Product[] = [
    {
        id: "prod-001",
        sku: "CC-IP15-BLK",
        name: "Capinha iPhone 15 Preta",
        description: "Silicone premium com proteção MagSafe",
        price: 4990,
        stock: 150,
        category: "iPhone",
    },
    {
        id: "prod-002",
        sku: "CC-IP15-CLA",
        name: "Capinha iPhone 15 Transparente",
        description: "Policarbonato anti-amarelamento",
        price: 3490,
        stock: 200,
        category: "iPhone",
    },
    {
        id: "prod-003",
        sku: "CC-S24-KEV",
        name: "Capinha Samsung S24 Kevlar",
        description: "Fibra de aramida ultrafina",
        price: 6990,
        stock: 75,
        category: "Samsung",
    },
    {
        id: "prod-004",
        sku: "CC-S24-LED",
        name: "Capinha Samsung S24 LED RGB",
        description: "Notificações via LED personalizáveis",
        price: 8990,
        stock: 30,
        category: "Samsung",
    },
    {
        id: "prod-005",
        sku: "CC-MOTO-RUG",
        name: "Capinha Motorola G84 Rugged",
        description: "Proteção militar MIL-STD-810G",
        price: 5990,
        stock: 60,
        category: "Motorola",
    },
    {
        id: "prod-006",
        sku: "CC-UNIV-WAL",
        name: "Carteira Universal com Ímã",
        description: "Compatível com todos modelos, 3 slots de cartão",
        price: 2990,
        stock: 300,
        category: "Acessórios",
    },
];

const PRODUCT_MAP = new Map<string, Product>(PRODUCTS.map((p) => [p.id, p]));

const simulateErpLatency = (): Promise<void> => {
    const delay = 50 + Math.floor(Math.random() * 100);
    return new Promise((resolve) => setTimeout(resolve, delay));
};

export const productsRepository = {
    async findAll(): Promise<Product[]> {
        await simulateErpLatency();
        return [...PRODUCTS];
    },

    async findById(id: string): Promise<Product | null> {
        await simulateErpLatency();
        return PRODUCT_MAP.get(id) ?? null;
    },

};
