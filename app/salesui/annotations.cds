using my.sales as db from '../../db/schema';

annotate db.SalesOrders with @(
    UI.LineItem : [
        { Value: customerName, Label: 'Customer' },
        { Value: product, Label: 'Product' },
        { Value: quantity, Label: 'Qty' },
        { Value: price, Label: 'Amount' },
        { Value: status, Label: 'Status' }
    ]
);

annotate db.Customers with @(
    UI.LineItem : [
        { Value: name, Label: 'Customer Name' },
        { Value: city, Label: 'City' },
        { Value: country, Label: 'Country' }
    ]
);